import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchAccountReceipt } from '../../shared/agent-launch-account'
import type { ProjectHostSetup } from '../../shared/project-types'
import {
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { LaunchPlacementClients } from '../launch-placement-clients'
import type { LaunchPlacementPreview } from '../launch-placement-format'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import type { AgentLaunchRecord } from '../session-launch-record'
import { readLaunchInput } from './session-launch-input'
import { runPlacedLaunch } from './session-launch-placement'
import type { LaunchReceiptResult } from './session-launch-receipt'

const KEY = 'github:omnirogue/omni-ide'
const NEW_CAPABILITIES = [
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
]
const ENVIRONMENTS = [{ id: 'env-2586', name: 'mw0002' }]
let userData = ''
let cwd = ''
let clock = 0

type Answer = (params: Record<string, unknown>) => unknown

function receipt(remainingPercent: number): AgentLaunchAccountReceipt {
  return {
    policy: 'best-verified',
    hostId: 'local',
    provider: 'claude',
    label: 'sal@example.com',
    choiceId: 'managed:a',
    remainingPercent,
    boundBy: 'weekly',
    readingAt: clock - 5_000,
    readingAgeMs: 5_000,
    fableVerified: false,
    verified: 1,
    considered: 1,
    excluded: [],
    why: 'most fresh verified headroom'
  }
}

function setup(change: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: KEY,
    hostId: 'local',
    repoId: 'repo-a',
    path: '/w/omni-ide',
    displayName: 'omni-ide',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...change
  }
}

/** A runtime with one project setup and one account at `percent` (null: limited). */
function runtime(options: {
  runtimeId: string
  percent: number | null
  isRemote: boolean
  setups?: ProjectHostSetup[]
  capabilities?: string[]
  appVersion?: string
  sshTargets?: { id: string; label: string }[]
  answers?: Record<string, Answer>
}) {
  const ssh = (worktree: unknown) => String(worktree).includes('studio')
  const account = (percent: number | null) =>
    percent === null
      ? {
          verified: false,
          refusal: 'No claude account has fresh verified capacity. Nothing launched.',
          accounts: [{ label: 'a', state: 'limited', reason: 'limited', until: clock + 3_600_000 }]
        }
      : { verified: true, receipt: receipt(percent) }
  const answers: Record<string, Answer> = {
    'status.get': () => ({
      runtimeId: options.runtimeId,
      appVersion: options.appVersion ?? '1.13.0',
      capabilities: options.capabilities ?? NEW_CAPABILITIES,
      sessionHost: { hostId: `machine-${options.runtimeId}`, incarnation: 'i' }
    }),
    'projectHostSetup.list': () => ({ setups: options.setups ?? [setup()] }),
    'project.list': () => ({
      projects: [
        {
          id: KEY,
          displayName: 'omni-ide',
          badgeColor: '',
          sourceRepoIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }),
    'ssh.listTargetSummaries': () => ({ targets: options.sshTargets ?? [] }),
    'terminal.agentLaunchReadiness': (params) => ({
      runtimeId: options.runtimeId,
      workspace: {
        id: String(params.worktree).replace(/^(id|path):/, ''),
        hostId: ssh(params.worktree) ? 'ssh:ssh-studio' : 'local',
        kind: String(params.worktree).startsWith('path:') ? 'folder' : 'git',
        path: '/w',
        name: null
      },
      ...(params.preview ? { account: account(ssh(params.worktree) ? 90 : options.percent) } : {}),
      ...(params.load
        ? {
            load: { loadPerCore: 0.2, band: 'ok', liveSessions: 1, observedAt: clock },
            machineId: ssh(params.worktree) ? 'machine-studio' : `machine-${options.runtimeId}`
          }
        : {})
    }),
    'worktree.create': (params) => ({
      worktree: { id: `${String(params.repo).slice(3)}::/wt/${String(params.name)}` },
      lineage: null,
      warnings: []
    }),
    'terminal.createAgentSession': () => ({
      terminal: { handle: 'term_new', paneKey: 'tab:leaf', worktreeId: 'w', title: null },
      disposition: 'created',
      account: receipt(options.percent ?? 0)
    }),
    'terminal.rename': () => ({ ok: true }),
    'repo.hooks': () => ({ hasHooksFile: false, hooks: null, setupRunPolicy: 'run-by-default' }),
    'repo.hooksCheck': () => ({ status: 'ok', hasHooks: false, hooks: null }),
    'repo.show': () => ({ repo: { id: 'repo-a' } }),
    ...options.answers
  }
  const call = vi.fn(async (method: string, params?: unknown) => {
    const answer = answers[method]
    if (!answer) {
      throw new RuntimeClientError('method_not_found', `Unknown method: ${method}`)
    }
    const result = await answer((params ?? {}) as Record<string, unknown>)
    return { id: 'r', ok: true, result, _meta: { runtimeId: options.runtimeId } }
  })
  return { call, answers, client: { call, isRemote: options.isRemote } as unknown as RuntimeClient }
}

type Fake = ReturnType<typeof runtime>

function clients(local: Fake, paired: Fake | null): LaunchPlacementClients {
  return {
    local: () => local.client,
    environment: () => paired!.client,
    environments: () => (paired ? ENVIRONMENTS : []),
    now: () => clock
  }
}

function calls(fake: Fake, method: string): Record<string, unknown>[] {
  return fake.call.mock.calls
    .filter(([name]) => name === method)
    .map(([, params]) => (params ?? {}) as Record<string, unknown>)
}

async function launch(
  local: Fake,
  paired: Fake | null,
  extra: [string, string | boolean][] = []
): Promise<void> {
  const flags = new Map<string, string | boolean>([
    ['provider', 'claude'],
    ['project', KEY],
    ['prompt', 'Fix the login timeout.'],
    ['title', 'Fix login timeout'],
    ...extra
  ])
  const input = await readLaunchInput(flags, cwd)
  await runPlacedLaunch({ flags, cwd, json: true }, input, clients(local, paired))
}

function lastJson<T = LaunchReceiptResult>(): { result: T } {
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string)
}

function records(): AgentLaunchRecord[] {
  const dir = join(userData, 'agent-launch-operations')
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as AgentLaunchRecord)
    : []
}

function timesOut(): never {
  throw new RuntimeClientError('runtime_timeout', 'Timed out waiting for the OmniConsole runtime.')
}

describe('omni session launch --project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clock = Date.now()
    userData = mkdtempSync(join(tmpdir(), 'omni-placement-userdata-'))
    cwd = mkdtempSync(join(tmpdir(), 'omni-placement-cwd-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('picks the computer with more headroom, journals then creates one fresh worktree there, and launches into it', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    let journaledBeforeSend: AgentLaunchRecord['placement'] | undefined
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 71,
      isRemote: true,
      setups: [setup({ repoId: 'repo-2586', path: '/u/omni-ide' })],
      answers: {
        'worktree.create': (params) => {
          journaledBeforeSend = records()[0]?.placement
          return {
            worktree: { id: `repo-2586::/wt/${String(params.name)}` },
            lineage: null,
            warnings: []
          }
        }
      }
    })
    await launch(local, paired)

    const { result } = lastJson()
    const { operationId } = result
    const [create] = calls(paired, 'worktree.create')
    expect(create).toMatchObject({
      repo: 'id:repo-2586',
      noParent: true,
      runHooks: false,
      setupDecision: 'run',
      clientMutationId: `launch-${operationId}`
    })
    expect(create!.name).toBe(`fix-login-timeout-${operationId.slice(-6)}`)
    expect(journaledBeforeSend).toMatchObject({ worktreeCreateRuntimeId: 'rt-2586' })
    expect(journaledBeforeSend?.worktreeCreateSentAt).toBe(clock)
    expect(journaledBeforeSend?.createdWorktreeId).toBeUndefined()
    expect(calls(paired, 'terminal.createAgentSession')[0]).toMatchObject({
      clientOperationId: operationId,
      worktree: `id:repo-2586::/wt/${String(create!.name)}`,
      sshAccountSelection: { expectedHostId: 'local', expectedRuntimeId: 'rt-2586' }
    })
    // Never a fallback or a second effect on the runner-up.
    expect(calls(local, 'worktree.create')).toEqual([])
    expect(calls(local, 'terminal.createAgentSession')).toEqual([])
    expect(result.host.why).toBe(
      'placed by rule v1: more fresh headroom than this computer (71% vs 42%)'
    )
    expect(result.placement).toMatchObject({
      rule: 'v1',
      project: { identityKey: KEY },
      chosen: { label: 'mw0002', route: { kind: 'environment', environmentId: 'env-2586' } },
      runnerUp: { label: 'this computer' },
      createdWorktreeId: `repo-2586::/wt/${String(create!.name)}`
    })
    expect(result.placement?.runnerUp?.command).toContain('--host local')
    expect(result.placement?.runnerUp?.command).toContain(`--project ${KEY}`)
    expect(result.retryCommand).toContain('--project')
    expect(result.retryCommand).not.toContain('--worktree')
  })

  it('a retry follows the frozen placement: it never reads the fleet again or creates a second worktree', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    let sends = 0
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 71,
      isRemote: true,
      answers: {
        'terminal.createAgentSession': () => {
          sends += 1
          if (sends === 1) {
            timesOut()
          }
          return {
            terminal: { handle: 'term_new', paneKey: 'tab:leaf', worktreeId: 'w', title: null },
            disposition: 'created'
          }
        }
      }
    })
    await expect(launch(local, paired)).rejects.toMatchObject({ code: 'launch_outcome_unknown' })
    const reads = (fake: Fake) =>
      calls(fake, 'projectHostSetup.list').length +
      calls(fake, 'terminal.agentLaunchReadiness').filter((params) => params.preview).length
    const before = { local: reads(local), paired: reads(paired) }
    // Even if this computer now looked better, the retry stays where it was placed.
    local.answers['terminal.agentLaunchReadiness'] = () => {
      throw new Error('the retry must not read candidates again')
    }
    clock += 10 * 60_000
    await launch(local, paired)

    expect({ local: reads(local), paired: reads(paired) }).toEqual(before)
    expect(calls(paired, 'worktree.create')).toHaveLength(1)
    const [first, second] = calls(paired, 'terminal.createAgentSession')
    expect(second).toEqual(first)
    expect(lastJson().result).toMatchObject({
      disposition: 'created',
      placement: { chosen: { label: 'mw0002' } }
    })
  })

  it('an unconfirmed worktree create is resent only inside the host dedupe window, never after it', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 80, isRemote: false })
    let creates = 0
    local.answers['worktree.create'] = (params) => {
      creates += 1
      if (creates === 1) {
        timesOut()
      }
      return { worktree: { id: `repo-a::/wt/${String(params.name)}` }, lineage: null, warnings: [] }
    }
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      data: { outcome: 'not-sent' }
    })
    clock += 30_000
    await launch(local, null)
    const [first, second] = calls(local, 'worktree.create')
    expect(second).toEqual(first)
    expect(calls(local, 'terminal.createAgentSession')).toHaveLength(1)

    // A second placement whose create is never answered, retried after the window, refuses.
    local.answers['worktree.create'] = timesOut
    await expect(launch(local, null, [['again', true]])).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable'
    })
    const createsBefore = calls(local, 'worktree.create').length
    clock += 61_000
    const refused = launch(local, null, [['title', 'Fix login timeout']])
    await expect(refused).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      message: expect.stringContaining('after its 60 s dedupe window')
    })
    await expect(refused).rejects.toMatchObject({
      data: { inspectCommand: expect.arrayContaining(['worktree', 'list', '--json']) }
    })
    expect(calls(local, 'worktree.create')).toHaveLength(createsBefore)
  })

  it('measures the resend window from the first send, so a lost resend never extends it', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 80, isRemote: false })
    local.answers['worktree.create'] = timesOut
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      message: expect.stringContaining('again within 45 s')
    })
    const firstSentAt = clock
    clock += 30_000
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      message: expect.stringContaining('again within 15 s')
    })
    expect(records()[0]?.placement?.worktreeCreateSentAt).toBe(firstSentAt)
    expect(calls(local, 'worktree.create')).toHaveLength(2)
    // The host forgets the create 60 s after the first one finished; this run must not resend.
    clock += 31_000
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      data: { nextSteps: [expect.stringContaining('worktree list --json')] }
    })
    expect(calls(local, 'worktree.create')).toHaveLength(2)
  })

  it('offers no resend once a slow create has used up the window', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 80, isRemote: false })
    local.answers['worktree.create'] = () => {
      clock += 120_000
      timesOut()
    }
    const refused = launch(local, null)
    await expect(refused).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      data: { nextSteps: [expect.stringContaining('worktree list --json')] }
    })
    const error = (await refused.catch((caught: unknown) => caught)) as Error
    expect(error.message).not.toContain('again within')
  })

  it('a re-run that cannot reach the computer after an unconfirmed create never says nothing was sent', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 71,
      isRemote: true,
      answers: { 'worktree.create': timesOut }
    })
    await expect(launch(local, paired)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable'
    })
    paired.answers['status.get'] = timesOut
    const refused = launch(local, paired)
    await expect(refused).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable',
      data: { inspectCommand: expect.arrayContaining(['--environment', 'mw0002']) }
    })
    const error = (await refused.catch((caught: unknown) => caught)) as Error
    expect(error.message).toContain(
      'could not be reached within 10 s to confirm its earlier create'
    )
    expect(error.message).not.toContain('Nothing was sent')
    expect(error.message).not.toContain('Runner-up')
    expect(calls(paired, 'worktree.create')).toHaveLength(1)
  })

  it('keeps the journal unless the host itself answered the create with an error', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 80, isRemote: false })
    local.answers['worktree.create'] = () => {
      throw new RuntimeClientError('invalid_runtime_response', 'mismatched response id')
    }
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_workspace_unverifiable'
    })
    expect(records()[0]?.placement?.worktreeCreateSentAt).toBe(clock)

    local.answers['worktree.create'] = () => {
      throw new RuntimeRpcFailureError({
        id: 'r',
        ok: false,
        error: { code: 'runtime_error', message: 'git worktree add failed' }
      })
    }
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'runtime_error',
      data: {
        outcome: 'not-sent',
        inspectCommand: expect.arrayContaining(['worktree', 'list', '--json']),
        nextSteps: expect.arrayContaining([
          expect.stringMatching(/lists fix-login-timeout-\w{6}, the failed create left it behind/)
        ])
      }
    })
    expect(records()[0]?.placement?.worktreeCreateSentAt).toBeUndefined()
  })

  it("puts the host's create warning on the receipt", async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 80, isRemote: false })
    local.answers['worktree.create'] = (params) => ({
      worktree: { id: `repo-a::/wt/${String(params.name)}` },
      lineage: null,
      warnings: [],
      warning: 'Failed to create the initial terminal: no shell'
    })
    await launch(local, null)
    expect(lastJson().result.warnings).toContain('Failed to create the initial terminal: no shell')
  })

  it('refuses before any effect when the repository must finish setup before its agent starts', async () => {
    const local = runtime({
      runtimeId: 'rt-local',
      percent: 80,
      isRemote: false,
      answers: {
        'repo.hooks': () => ({ hooks: { scripts: { setup: 'pnpm install' } } }),
        'repo.hooksCheck': () => ({
          status: 'ok',
          hooks: { scripts: { setup: 'pnpm install' }, setupAgentStartupPolicy: 'wait-for-setup' }
        })
      }
    })
    await expect(launch(local, null)).rejects.toMatchObject({
      code: 'launch_setup_first',
      data: {
        outcome: 'not-sent',
        nextSteps: [expect.stringContaining('--setup run --agent claude')]
      }
    })
    expect(records()).toEqual([])
    expect(calls(local, 'worktree.create')).toEqual([])
    // The Settings policy counts too, and a dry run reports the refusal and exits 0.
    local.answers['repo.hooksCheck'] = () => ({ status: 'ok', hooks: null })
    local.answers['repo.show'] = () => ({
      repo: { hookSettings: { setupAgentStartupPolicy: 'wait-for-setup' } }
    })
    await launch(local, null, [['dry-run', true]])
    expect(lastJson<LaunchPlacementPreview>().result.wouldRefuse).toMatchObject({
      code: 'launch_setup_first'
    })
    // Without a setup script there is nothing to wait for.
    local.answers['repo.hooks'] = () => ({ hooks: null })
    await launch(local, null)
    expect(calls(local, 'terminal.createAgentSession')).toHaveLength(1)
  })

  it('after a definitive refusal it stops, names the runner-up and reports the created worktree', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 71,
      isRemote: true,
      answers: {
        'terminal.createAgentSession': () => {
          throw new RuntimeClientError(
            'agent_session_account_unverified',
            'No claude account on mw0002 has fresh verified capacity. Nothing launched.'
          )
        }
      }
    })
    const failed = launch(local, paired)
    await expect(failed).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      data: {
        outcome: 'not-started',
        runnerUp: { label: 'this computer' },
        createdWorktree: { removeCommand: expect.stringContaining('--environment mw0002') }
      }
    })
    const error = (await failed.catch((caught: unknown) => caught)) as RuntimeClientError
    expect(error.message).toContain('Runner-up: this computer: ')
    expect(error.message).toMatch(/worktree rm --worktree id:repo-a::\/wt\/fix-login-timeout-\w{6}/)
    expect(calls(paired, 'worktree.create')).toHaveLength(1)
    expect(calls(local, 'worktree.create')).toEqual([])
    expect(calls(local, 'terminal.createAgentSession')).toEqual([])
  })

  it('refuses by name when no computer can take it, recording and creating nothing (R17)', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: null, isRemote: false })
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 90,
      isRemote: true,
      appVersion: '1.12.18',
      capabilities: [WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]
    })
    const refused = launch(local, paired)
    await expect(refused).rejects.toMatchObject({
      code: 'launch_no_computer',
      data: { outcome: 'not-sent', candidates: expect.any(Array) }
    })
    const error = (await refused.catch((caught: unknown) => caught)) as Error
    expect(error.message.split('\n')[0]).toBe(
      `No computer can take this claude launch for ${KEY} now:`
    )
    expect(error.message).toContain('\n  this computer: ')
    expect(error.message).toContain('\n  mw0002: OmniConsole 1.12.18')
    expect(error.message.endsWith('Nothing launched.')).toBe(true)
    expect(records()).toEqual([])
    for (const fake of [local, paired]) {
      expect(calls(fake, 'worktree.create')).toEqual([])
      expect(calls(fake, 'terminal.createAgentSession')).toEqual([])
    }
  })

  it('--dry-run shows the ranked computers and the pick, and records, creates and launches nothing', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    const paired = runtime({ runtimeId: 'rt-2586', percent: 71, isRemote: true })
    await launch(local, paired, [['dry-run', true]])
    const { result } = lastJson<LaunchPlacementPreview>()
    expect(result).toMatchObject({
      launched: false,
      operationId: null,
      wouldRefuse: null,
      placement: {
        chosen: { label: 'mw0002' },
        workspacePlan: {
          kind: 'new-worktree',
          name: 'fix-login-timeout-<last 6 of the operation id>'
        }
      }
    })
    expect(result.candidates.map((entry) => entry.label)).toEqual(['mw0002', 'this computer'])
    expect(records()).toEqual([])
    for (const fake of [local, paired]) {
      expect(calls(fake, 'worktree.create')).toEqual([])
      expect(calls(fake, 'terminal.createAgentSession')).toEqual([])
    }
  })

  it('--dry-run of a command that already froze a pick shows that pick and never re-ranks', async () => {
    const local = runtime({ runtimeId: 'rt-local', percent: 42, isRemote: false })
    const paired = runtime({
      runtimeId: 'rt-2586',
      percent: 71,
      isRemote: true,
      answers: { 'terminal.createAgentSession': () => timesOut() }
    })
    await expect(launch(local, paired)).rejects.toMatchObject({ code: 'launch_outcome_unknown' })
    const [frozen] = records()
    const setupReads = () =>
      calls(local, 'projectHostSetup.list').length + calls(paired, 'projectHostSetup.list').length
    const before = setupReads()
    // A preview must not read candidates again; the real re-run would still follow mw0002.
    const readiness = local.answers['terminal.agentLaunchReadiness']!
    local.answers['terminal.agentLaunchReadiness'] = () => {
      throw new Error('a preview of a frozen pick must not read candidates again')
    }
    await launch(local, paired, [['dry-run', true]])
    const { result } = lastJson<LaunchPlacementPreview>()
    expect(result).toMatchObject({
      launched: false,
      operationId: null,
      wouldRefuse: null,
      continues: { operationId: frozen!.operationId },
      placement: { chosen: { label: 'mw0002' } }
    })
    expect(result.candidates.map((entry) => entry.label)).toEqual(['mw0002', 'this computer'])
    expect(setupReads()).toBe(before)
    expect(records()).toHaveLength(1)
    expect(calls(paired, 'worktree.create')).toHaveLength(1)
    expect(calls(paired, 'terminal.createAgentSession')).toHaveLength(1)
    // --again places afresh, so its preview ranks again.
    local.answers['terminal.agentLaunchReadiness'] = readiness
    await launch(local, paired, [
      ['dry-run', true],
      ['again', true]
    ])
    expect(lastJson<LaunchPlacementPreview>().result).toMatchObject({ continues: null })
    expect(setupReads()).toBeGreaterThan(before)
  })

  it('--host next to --project keeps it on that computer, and a folder project launches into its folder', async () => {
    const local = runtime({
      runtimeId: 'rt-local',
      percent: 20,
      isRemote: false,
      setups: [setup({ kind: 'folder', path: '/w/notes' })]
    })
    const paired = runtime({ runtimeId: 'rt-2586', percent: 90, isRemote: true })
    await launch(local, paired, [['host', 'this mac']])
    expect(paired.call).not.toHaveBeenCalled()
    expect(calls(local, 'worktree.create')).toEqual([])
    expect(calls(local, 'terminal.createAgentSession')[0]).toMatchObject({
      worktree: 'path:/w/notes',
      sshAccountSelection: { expectedHostId: 'local' }
    })
    const { result } = lastJson()
    expect(result.placement?.workspacePlan).toEqual({ kind: 'folder', path: '/w/notes' })
    expect(result.warnings.join(' ')).toContain('shared folder /w/notes')
  })

  it("launches through this computer's SSH route with the SSH host's own account check", async () => {
    const local = runtime({
      runtimeId: 'rt-local',
      percent: 30,
      isRemote: false,
      setups: [
        setup(),
        setup({
          id: 'setup-ssh',
          hostId: 'ssh:ssh-studio',
          repoId: 'repo-studio',
          path: '/srv/omni-ide'
        })
      ],
      sshTargets: [{ id: 'ssh-studio', label: 'studio' }]
    })
    await launch(local, null)
    expect(calls(local, 'worktree.create')[0]).toMatchObject({ repo: 'id:repo-studio' })
    expect(calls(local, 'terminal.createAgentSession')[0]).toMatchObject({
      sshAccountSelection: { expectedHostId: 'ssh:ssh-studio', expectedRuntimeId: 'rt-local' }
    })
    expect(lastJson().result.placement?.chosen).toMatchObject({
      label: 'studio',
      route: { kind: 'ssh', targetId: 'ssh-studio' },
      machineId: 'machine-studio'
    })
  })

  it('refuses --project with --worktree, --host auto without --project, and --name without --project', async () => {
    const read = (entries: [string, string | boolean][]) =>
      readLaunchInput(
        new Map<string, string | boolean>([['provider', 'claude'], ['prompt', 'x'], ...entries]),
        cwd
      )
    await expect(
      read([
        ['project', KEY],
        ['worktree', 'id:w']
      ])
    ).rejects.toMatchObject({
      message: expect.stringContaining('a worktree already fixes the computer'),
      data: {
        outcome: 'not-sent',
        nextSteps: [expect.stringMatching(/^Omit --project to launch into that worktree/)]
      }
    })
    await expect(read([['host', 'auto']])).rejects.toThrow('which needs --project <name|id>')
    await expect(read([['name', 'x']])).rejects.toThrow('--name names the fresh worktree')
    await expect(
      read([
        ['project', KEY],
        ['environment', 'mw0002']
      ])
    ).rejects.toThrow('--project cannot take --environment')
    await expect(
      read([
        ['project', KEY],
        ['host', 'AUTO'],
        ['name', 'login-fix']
      ])
    ).resolves.toMatchObject({ project: KEY, worktreeName: 'login-fix' })
  })
})
