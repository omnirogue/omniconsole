import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessParams
} from '../shared/agent-launch-account'
import type { Project } from '../shared/project-types'
import type { SshTargetSummary } from './host-selector-alternatives'
import {
  readLaunchCandidates,
  resolveLaunchProject,
  type LaunchCandidateQuery,
  type LaunchCandidateReaderDeps,
  type LaunchRpcClient
} from './launch-candidate-reader'
import {
  NEW_RUNTIME_CAPABILITIES,
  NOW,
  OLD_RUNTIME_CAPABILITIES,
  OMNI_IDE,
  capacityRow,
  fakeRuntime,
  projectSetup,
  readinessResult,
  rpcError,
  type FakeRuntime,
  type FakeRuntimeAnswers
} from './launch-capacity-test-fixtures'

// Why: readiness must answer for the runtime whose status was read (runtime() names it so).
const NEW_RUNTIME_ID = 'rt-1.13.0'

function query(change: Partial<LaunchCandidateQuery> = {}): LaunchCandidateQuery {
  return { provider: 'claude', model: null, project: null, readOldRuntimeAccounts: true, ...change }
}

function runtime(
  capabilities: string[],
  answers: FakeRuntimeAnswers = {},
  appVersion = '1.13.0'
): FakeRuntime {
  return fakeRuntime({
    'status.get': { runtimeId: `rt-${appVersion}`, appVersion, capabilities },
    'projectHostSetup.list': { setups: [] },
    ...answers
  })
}

function readerDeps(
  local: FakeRuntime,
  environments: { id: string; name: string; runtime: FakeRuntime }[] = [],
  sshTargets: SshTargetSummary[] = [],
  now: () => number = () => NOW
): LaunchCandidateReaderDeps {
  return {
    now,
    local,
    environment: (id) => environments.find((environment) => environment.id === id)!.runtime,
    environments: environments.map(({ id, name }) => ({ id, name })),
    listSshTargets: async () => sshTargets
  }
}

const readinessCalls = (client: FakeRuntime) =>
  client.calls.filter((call) => call.method === AGENT_LAUNCH_READINESS_METHOD)

afterEach(() => {
  vi.useRealTimers()
})

describe('readLaunchCandidates', () => {
  it('reads older runtimes read-only with accounts.list on their own clock', async () => {
    const local = runtime(
      OLD_RUNTIME_CAPABILITIES,
      {
        'projectHostSetup.list': {
          setups: [projectSetup(), projectSetup({ id: 'ssh', hostId: 'ssh:ssh-2602' })]
        },
        'accounts.list': {
          rateLimits: { accountCapacity: { claude: [capacityRow()], codex: [], builtAt: NOW } }
        }
      },
      '1.12.20'
    )
    // Why skewed: Mac Studio's clock runs 10 min behind; its 20 s old reading is still fresh.
    const studioNow = NOW - 600_000
    const studio = runtime(
      OLD_RUNTIME_CAPABILITIES,
      {
        'accounts.list': {
          rateLimits: {
            accountCapacity: {
              claude: [capacityRow({ readingAt: studioNow - 20_000 })],
              codex: [],
              builtAt: studioNow
            }
          }
        }
      },
      '1.12.18'
    )

    const readings = await readLaunchCandidates(
      query(),
      readerDeps(
        local,
        [{ id: 'env-studio', name: 'Mac Studio', runtime: studio }],
        [{ id: 'ssh-2602', label: 'mw0004' }]
      )
    )

    expect(readings.map(({ candidate }) => [candidate.label, candidate.state])).toEqual([
      ['this computer', 'old-runtime'],
      ['Mac Studio', 'old-runtime'],
      ['mw0004', 'old-runtime']
    ])
    expect([...readinessCalls(local), ...readinessCalls(studio)]).toEqual([])
    expect(studio.calls.find((call) => call.method === 'accounts.list')?.params).toEqual({
      refreshUsage: true
    })
    expect(readings[1]!.listedAccounts).toMatchObject({
      freshness: 'fresh',
      bestRemainingPercent: 64,
      readingAgeMs: 20_000,
      source: 'accounts-list'
    })
    // Why: an SSH route is driven by this computer's runtime, which is the one needing the update.
    expect(readings[2]!.listedAccounts).toBeNull()
    expect(readings[2]!.candidate.reason).toContain("this computer's OmniConsole 1.12.20")
  })

  it("asks a new runtime's readiness for the chosen setup, with load, and nothing else", async () => {
    const sent: AgentLaunchReadinessParams[] = []
    const local = runtime(NEW_RUNTIME_CAPABILITIES, {
      'projectHostSetup.list': { setups: [projectSetup()] },
      [AGENT_LAUNCH_READINESS_METHOD]: (params: AgentLaunchReadinessParams) => {
        sent.push(params)
        return readinessResult({ runtimeId: NEW_RUNTIME_ID, machineId: 'mach-local' })
      }
    })

    const [reading] = await readLaunchCandidates(
      query({ project: OMNI_IDE, model: 'claude-opus-4-1' }),
      readerDeps(local)
    )

    expect(sent).toEqual([
      {
        worktree: 'id:repo-1::/w/omni-ide',
        agent: 'claude',
        model: 'claude-opus-4-1',
        preview: true,
        load: true
      }
    ])
    expect(reading!.candidate).toMatchObject({ state: 'fresh', machineId: 'mach-local' })
    expect(reading!.listedAccounts).toBeNull()
    expect(local.calls.some((call) => call.method === 'accounts.list')).toBe(false)
  })

  it('asks again without load when a strict runtime refuses the newer field', async () => {
    const local = runtime(NEW_RUNTIME_CAPABILITIES, {
      'projectHostSetup.list': { setups: [projectSetup()] },
      [AGENT_LAUNCH_READINESS_METHOD]: (params: AgentLaunchReadinessParams) =>
        params.load
          ? rpcError('invalid_argument')
          : readinessResult({ runtimeId: NEW_RUNTIME_ID, load: undefined })
    })

    const [reading] = await readLaunchCandidates(query(), readerDeps(local))

    expect(readinessCalls(local).map((call) => 'load' in (call.params as object))).toEqual([
      true,
      false
    ])
    expect(reading!.candidate).toMatchObject({ state: 'fresh', load: null })
  })

  it('reads a computer that does not answer as unverifiable, without echoing the transport', async () => {
    const late = fakeRuntime({
      'status.get': rpcError('runtime_timeout'),
      'projectHostSetup.list': rpcError('runtime_timeout')
    })
    const gone = fakeRuntime({
      'status.get': rpcError(
        'remote_runtime_unavailable',
        'Could not connect to ws://100.64.0.2:4000'
      ),
      'projectHostSetup.list': rpcError('remote_runtime_unavailable')
    })

    const readings = await readLaunchCandidates(
      query(),
      readerDeps(runtime(NEW_RUNTIME_CAPABILITIES), [
        { id: 'env-2586', name: 'mw0002', runtime: late },
        { id: 'env-2601', name: 'mw0003', runtime: gone }
      ])
    )

    expect(readings[1]!.candidate).toMatchObject({
      state: 'unverifiable',
      reachable: false,
      reason: 'did not answer within 8 s (unverifiable)'
    })
    expect(readings[1]!.listedAccounts).toBeNull()
    expect(readings[2]!.candidate.reason).toBe(
      'could not be reached (remote_runtime_unavailable; unverifiable)'
    )
  })

  it('drives SSH workspaces through this computer and skips nested SSH behind a paired one', async () => {
    const local = runtime(NEW_RUNTIME_CAPABILITIES, {
      'projectHostSetup.list': {
        setups: [
          projectSetup({
            id: 'ssh',
            hostId: 'ssh:ssh-2586',
            repoId: 'repo-ssh',
            path: '/home/sal/omni-ide'
          })
        ]
      },
      [AGENT_LAUNCH_READINESS_METHOD]: () =>
        readinessResult({
          runtimeId: NEW_RUNTIME_ID,
          machineId: 'mach-2586',
          workspace: { ...readinessResult().workspace, hostId: 'ssh:ssh-2586' }
        })
    })
    const paired = runtime(NEW_RUNTIME_CAPABILITIES, {
      'projectHostSetup.list': { setups: [projectSetup({ hostId: 'ssh:ssh-behind' })] }
    })

    const readings = await readLaunchCandidates(
      query({ project: OMNI_IDE }),
      readerDeps(
        local,
        [{ id: 'env-2586', name: 'mw0002', runtime: paired }],
        [{ id: 'ssh-2586', label: 'mw0002' }]
      )
    )

    expect(readings.map(({ candidate }) => [candidate.route.kind, candidate.state])).toEqual([
      ['local', 'no-setup'],
      ['environment', 'nested-ssh'],
      ['ssh', 'fresh']
    ])
    expect(
      readinessCalls(local).map((call) => (call.params as { worktree: string }).worktree)
    ).toEqual(['id:repo-ssh::/home/sal/omni-ide'])
    expect(readinessCalls(paired)).toEqual([])
    expect(readings[2]!.candidate).toMatchObject({ machineId: 'mach-2586', hostId: 'ssh:ssh-2586' })
  })

  it('reads only the routes placement allows when --host names one computer', async () => {
    const skipped = runtime(NEW_RUNTIME_CAPABILITIES)

    const readings = await readLaunchCandidates(
      query({ only: (route) => route.kind === 'local' }),
      readerDeps(runtime(NEW_RUNTIME_CAPABILITIES), [
        { id: 'env-1', name: 'laptop', runtime: skipped }
      ])
    )

    expect(readings.map(({ candidate }) => candidate.route.kind)).toEqual(['local'])
    expect(skipped.calls).toEqual([])
  })

  it('marks a computer that misses the overall deadline unverifiable', async () => {
    vi.useFakeTimers()
    const stuck = fakeRuntime({
      'status.get': () => new Promise(() => {}),
      'projectHostSetup.list': () => new Promise(() => {})
    })

    const pending = readLaunchCandidates(
      query(),
      readerDeps(
        runtime(NEW_RUNTIME_CAPABILITIES),
        [{ id: 'env-1', name: 'laptop', runtime: stuck }],
        [],
        () => Date.now()
      )
    )
    await vi.advanceTimersByTimeAsync(45_000)
    const readings = await pending

    expect(readings[1]!.candidate).toMatchObject({ state: 'unverifiable', reachable: false })
    expect(readings[1]!.candidate.reason).toContain('45 s overall deadline')
  })

  it('caps each call to the time left and sends nothing once the deadline has passed', async () => {
    vi.useFakeTimers()
    const sent: { method: string; timeoutMs?: number }[] = []
    const answering = (answerAfterMs: number): LaunchRpcClient => {
      const inner = runtime(NEW_RUNTIME_CAPABILITIES, {
        'projectHostSetup.list': { setups: [projectSetup()] },
        [AGENT_LAUNCH_READINESS_METHOD]: () => new Promise(() => {})
      })
      return {
        call: (async (method: string, params?: unknown, options?: { timeoutMs?: number }) => {
          sent.push({ method, timeoutMs: options?.timeoutMs })
          await new Promise((resolve) => setTimeout(resolve, answerAfterMs))
          return inner.call(method, params)
        }) as LaunchRpcClient['call']
      }
    }
    const read = (client: LaunchRpcClient) =>
      readLaunchCandidates(
        query({ project: OMNI_IDE }),
        readerDeps(
          runtime(NEW_RUNTIME_CAPABILITIES),
          [{ id: 'env-1', name: 'laptop', runtime: client as FakeRuntime }],
          [],
          () => Date.now()
        )
      )

    // Status and setups answer at 40 s: readiness goes out with only the 5 s left.
    const capped = read(answering(40_000))
    await vi.advanceTimersByTimeAsync(45_000)
    await capped
    expect(sent.find((call) => call.method === AGENT_LAUNCH_READINESS_METHOD)?.timeoutMs).toBe(
      5_000
    )

    // Status and setups answer after the deadline: their follow-up is never sent.
    sent.length = 0
    const late = read(answering(50_000))
    await vi.advanceTimersByTimeAsync(45_000)
    await late
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.map((call) => call.method)).toEqual(['status.get', 'projectHostSetup.list'])
  })
})

describe('resolveLaunchProject', () => {
  const project = (id: string, displayName: string) => ({ id, displayName }) as Project
  const client = fakeRuntime({
    'project.list': {
      projects: [
        project('github:omnirogue/omni-ide', 'omni-ide'),
        project('repo:1', 'Ops'),
        project('repo:2', 'ops')
      ]
    }
  })

  it('takes an id or a unique name this computer lists, and an identity key as typed', async () => {
    await expect(resolveLaunchProject('omni-ide', client)).resolves.toEqual(OMNI_IDE)
    await expect(resolveLaunchProject('GitHub:omnirogue/OmniRogue', client)).resolves.toEqual({
      input: 'GitHub:omnirogue/OmniRogue',
      identityKey: 'github:omnirogue/omnirogue',
      name: null
    })
    await expect(resolveLaunchProject('github:x/y', fakeRuntime({}))).resolves.toMatchObject({
      identityKey: 'github:x/y'
    })
  })

  it('refuses an ambiguous or unknown name by name', async () => {
    await expect(resolveLaunchProject('ops', client)).rejects.toThrow(
      'Ambiguous project "ops": 2 projects share that name. Pass its id: repo:1, repo:2.'
    )
    await expect(resolveLaunchProject('nope', client)).rejects.toThrow('Unknown project "nope"')
  })
})
