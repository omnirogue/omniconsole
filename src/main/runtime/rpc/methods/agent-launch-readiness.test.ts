import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchHostId,
  AgentLaunchReadinessParams
} from '../../../../shared/agent-launch-account'
import { prepareSessionPrepRemoteAccountSelection } from '../../../session-prep/session-prep-remote-account'
import { SessionPrepAccountPreparationError } from '../../../session-prep/session-prep-ids'
import {
  resolveAgentLaunchReadiness,
  type AgentLaunchReadinessTarget
} from '../../agent-launch-readiness'
import type { AgentLaunchLoadReport } from '../../agent-launch-load'
import type { LaunchAccountCapacity } from '../../agent-session-local-account'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { AGENT_LAUNCH_READINESS_METHODS } from './agent-launch-readiness'

vi.mock('../../../session-prep/session-prep-remote-account', () => ({
  prepareSessionPrepRemoteAccountSelection: vi.fn()
}))

const RUNTIME_ID = '11111111-1111-4111-8111-111111111111'
const MACHINE_ID = 'host_0123456789abcdef0123456789abcdef'
const LOAD_REPORT: AgentLaunchLoadReport = {
  load: { loadPerCore: 0.31, band: 'ok', liveSessions: null, observedAt: 5_000 },
  machineId: MACHINE_ID
}

function target(connectionId: string | null): AgentLaunchReadinessTarget {
  return {
    scope: {
      id: 'repo::/work',
      path: '/work',
      connectionId,
      repo: { kind: 'git' },
      folderWorkspace: null
    },
    managedWorktree: { displayName: 'work' }
  }
}

function capacityStub() {
  return {
    resolve: vi.fn<LaunchAccountCapacity['resolve']>(async () => {}),
    snapshot: vi.fn<LaunchAccountCapacity['snapshot']>(() => ({
      claude: [],
      codex: [],
      builtAt: 0
    })),
    refresh: vi.fn<LaunchAccountCapacity['refresh']>(async () => ({}) as never)
  }
}

function harness(
  connectionId: string | null,
  capacity: LaunchAccountCapacity | null = capacityStub(),
  runsInWsl = vi.fn(() => false),
  readLoad = vi.fn(async (_hostId: AgentLaunchHostId) => LOAD_REPORT)
) {
  const agentLaunchReadiness = vi.fn((params: AgentLaunchReadinessParams) =>
    resolveAgentLaunchReadiness(
      {
        runtimeId: RUNTIME_ID,
        resolveWorkspace: async () => target(connectionId),
        runsInWsl,
        capacity,
        readLoad
      },
      params
    )
  )
  const dispatcher = new RpcDispatcher({
    runtime: {
      getRuntimeId: () => RUNTIME_ID,
      agentLaunchReadiness
    } as unknown as OrcaRuntimeService,
    methods: AGENT_LAUNCH_READINESS_METHODS
  })
  const call = (params: unknown) =>
    dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'terminal.agentLaunchReadiness',
      params
    } satisfies RpcRequest)
  return { call, agentLaunchReadiness, readLoad }
}

describe('terminal.agentLaunchReadiness', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts only strict {worktree, agent, model?, preview, load?}', async () => {
    const { call, agentLaunchReadiness } = harness(null)
    for (const params of [
      { worktree: 'id:repo::/work', agent: 'claude', preview: false, extra: true },
      { worktree: 'id:repo::/work', agent: 'claude', preview: false, load: 'yes' },
      { worktree: 'id:repo::/work', agent: 'gemini', preview: false },
      { worktree: 'id:repo::/work', agent: 'claude' },
      { worktree: ' id:repo::/work', agent: 'claude', preview: false },
      { worktree: 'id:repo::/work', agent: 'claude', model: '', preview: false }
    ]) {
      await expect(call(params)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(agentLaunchReadiness).not.toHaveBeenCalled()
    await expect(
      call({ worktree: 'id:repo::/work', agent: 'codex', model: 'gpt-5.5', preview: false })
    ).resolves.toMatchObject({ ok: true })
    expect(agentLaunchReadiness).toHaveBeenCalledWith({
      worktree: 'id:repo::/work',
      agent: 'codex',
      model: 'gpt-5.5',
      preview: false
    })
  })

  it('reports local without a connection and ssh:<id> with one', async () => {
    const params = { worktree: 'id:repo::/work', agent: 'claude', preview: false }
    await expect(harness(null).call(params)).resolves.toMatchObject({
      ok: true,
      result: {
        runtimeId: RUNTIME_ID,
        workspace: { id: 'repo::/work', hostId: 'local', kind: 'git', path: '/work', name: 'work' }
      }
    })
    await expect(harness('worker').call(params)).resolves.toMatchObject({
      ok: true,
      result: { workspace: { hostId: 'ssh:worker' } }
    })
  })

  it.each([null, 'worker'])('reports workspace kind on host %s', async (connectionId) => {
    for (const [repo, kind] of [
      [{ kind: 'folder' }, 'folder'],
      [{ kind: 'git' }, 'git'],
      [{}, 'git'],
      [null, 'folder']
    ] as const) {
      const workspace = target(connectionId)
      workspace.scope.repo = repo
      const readiness = await resolveAgentLaunchReadiness(
        {
          runtimeId: RUNTIME_ID,
          resolveWorkspace: async () => workspace,
          runsInWsl: () => false,
          capacity: null,
          readLoad: async () => LOAD_REPORT
        },
        { worktree: 'path:/work', agent: 'codex', preview: false }
      )
      expect(readiness.workspace).toMatchObject({
        kind,
        hostId: connectionId ? `ssh:${connectionId}` : 'local',
        path: '/work'
      })
    }
  })

  it('does not refresh capacity or read load when preview and load are off', async () => {
    const capacity = capacityStub()
    const { call, readLoad } = harness(null, capacity)
    const response = await call({
      worktree: 'id:repo::/work',
      agent: 'claude',
      preview: false
    })
    expect(response).toMatchObject({ ok: true })
    expect(response.ok && response.result).not.toHaveProperty('account')
    // Absent, not null: this caller never asked, so placement fields stay unevaluated.
    expect(response.ok && response.result).not.toHaveProperty('load')
    expect(response.ok && response.result).not.toHaveProperty('machineId')
    expect(readLoad).not.toHaveBeenCalled()
    expect(capacity.resolve).not.toHaveBeenCalled()
    expect(capacity.snapshot).not.toHaveBeenCalled()
    expect(capacity.refresh).not.toHaveBeenCalled()
    expect(prepareSessionPrepRemoteAccountSelection).not.toHaveBeenCalled()
  })

  it('maps an SSH relay refusal to verified:false with its text', async () => {
    const text =
      'No claude account has fresh verified capacity on this SSH host. Check its signed-in accounts and usage; nothing launched.'
    vi.mocked(prepareSessionPrepRemoteAccountSelection).mockRejectedValue(
      new SessionPrepAccountPreparationError(text)
    )
    await expect(
      harness('worker').call({
        worktree: 'id:repo::/work',
        agent: 'claude',
        model: 'opus',
        preview: true
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        workspace: { hostId: 'ssh:worker' },
        account: { verified: false, refusal: text, accounts: [] }
      }
    })
    expect(prepareSessionPrepRemoteAccountSelection).toHaveBeenCalledWith(
      'worker',
      'claude',
      'opus'
    )
  })

  it('previews the WSL refusal for a workspace the runtime runs in WSL, without reading capacity', async () => {
    const capacity = capacityStub()
    const runsInWsl = vi.fn(() => true)
    await expect(
      harness(null, capacity, runsInWsl).call({
        worktree: 'id:repo::/work',
        agent: 'claude',
        preview: true
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        account: { verified: false, refusal: expect.stringContaining('WSL'), accounts: [] }
      }
    })
    expect(runsInWsl).toHaveBeenCalledWith(target(null).scope)
    expect(capacity.resolve).not.toHaveBeenCalled()
  })

  it('reports verified:false without account services', async () => {
    await expect(
      harness(null, null).call({ worktree: 'id:repo::/work', agent: 'codex', preview: true })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        workspace: { hostId: 'local' },
        account: {
          verified: false,
          refusal: expect.stringContaining('without account services'),
          accounts: []
        }
      }
    })
  })

  it('with load, reads the executing host: local for its own workspaces, ssh:<id> otherwise', async () => {
    const local = harness(null)
    await expect(
      local.call({ worktree: 'id:repo::/work', agent: 'claude', preview: false, load: true })
    ).resolves.toMatchObject({
      ok: true,
      result: { workspace: { hostId: 'local' }, ...LOAD_REPORT }
    })
    expect(local.readLoad).toHaveBeenCalledWith('local')
    const ssh = harness('worker')
    await ssh.call({ worktree: 'id:repo::/work', agent: 'claude', preview: false, load: true })
    expect(ssh.readLoad).toHaveBeenCalledWith('ssh:worker')
  })

  it('reports an unread host as null load and machine id, never zero or idle', async () => {
    const readLoad = vi.fn(async () => {
      throw new Error('That SSH host is not connected.')
    })
    const response = await harness(
      'worker',
      capacityStub(),
      vi.fn(() => false),
      readLoad
    ).call({
      worktree: 'id:repo::/work',
      agent: 'claude',
      preview: false,
      load: true
    })
    expect(response).toMatchObject({ ok: true, result: { load: null, machineId: null } })
  })

  it('reads load alongside the account preview rather than after it', async () => {
    let releaseProbe!: () => void
    vi.mocked(prepareSessionPrepRemoteAccountSelection).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          releaseProbe = () => reject(new SessionPrepAccountPreparationError('No account.'))
        })
    )
    const { call, readLoad } = harness('worker')
    const pending = call({ worktree: 'id:repo::/work', agent: 'claude', preview: true, load: true })
    await vi.waitFor(() => expect(readLoad).toHaveBeenCalledWith('ssh:worker'))
    releaseProbe()
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { account: { verified: false }, load: LOAD_REPORT.load, machineId: MACHINE_ID }
    })
  })
})
