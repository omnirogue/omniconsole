import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  agentLaunchRefusal,
  type AgentLaunchAccountReceipt
} from '../../shared/agent-launch-account'
import { OrcaRuntimeService } from './omni-runtime'
import { prepareAgentSessionSshAccount } from './agent-session-ssh-account'
import { prepareAgentSessionLocalAccount } from './agent-session-local-account'

vi.mock('./agent-session-ssh-account', () => ({
  prepareAgentSessionSshAccount: vi.fn(),
  sshLaunchAccountReceipt: vi.fn()
}))
vi.mock('./agent-session-local-account', () => ({
  prepareAgentSessionLocalAccount: vi.fn(),
  previewLocalLaunchAccount: vi.fn()
}))

function receipt(hostId: AgentLaunchAccountReceipt['hostId']): AgentLaunchAccountReceipt {
  return {
    policy: 'best-verified',
    hostId,
    provider: 'claude',
    label: 'a@example.com',
    choiceId: hostId === 'local' ? 'managed:a' : null,
    remainingPercent: 71,
    boundBy: hostId === 'local' ? 'weekly' : null,
    readingAt: 1_800_000_000_000,
    readingAgeMs: 4_000,
    fableVerified: false,
    verified: hostId === 'local' ? 2 : null,
    considered: hostId === 'local' ? 3 : null,
    excluded: [],
    why: 'most fresh verified headroom (71%, weekly) of 2 verified accounts'
  }
}

function fixture(store: Record<string, unknown> = {}) {
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    }),
    ...store
  } as never)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    executionOwnerSupportsAgentSessionOperation: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internals.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'workspace',
    path: '/remote/work',
    connectionId: 'worker',
    repo: null,
    folderWorkspace: null
  }))
  internals.executionOwnerSupportsAgentSessionOperation = vi.fn(async () => true)
  internals.markRemoteWorkspaceTrustedForAgent = vi.fn()
  const assertCurrent = vi.fn()
  vi.mocked(prepareAgentSessionSshAccount).mockResolvedValue({
    env: { CODEX_HOME: '/remote/profile' },
    assertCurrent,
    receipt: receipt('ssh:worker'),
    fableVerified: false
  })
  const spawn = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_created',
    ptyId: 'pty-created',
    tabId: 'tab',
    paneKey: 'tab:leaf',
    worktreeId: 'workspace',
    title: null,
    surface: 'background'
  })
  const request: RuntimeCreateAgentSessionRequest = {
    clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
    worktree: 'id:workspace',
    agent: 'codex',
    prompt: 'Do the work',
    viewMode: 'terminal',
    launchPreferences: { model: 'pinned-model', effort: 'high' },
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'ssh:worker',
      expectedRuntimeId: runtime.getRuntimeId()
    }
  }
  return { runtime, request, assertCurrent, spawn }
}

describe('native SSH launch account operation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('reserves before selecting an account and replays without selecting or spawning twice', async () => {
    const { runtime, request, assertCurrent, spawn } = fixture()
    const results = await Promise.all([
      runtime.createAgentSession(request),
      runtime.createAgentSession(request)
    ])
    expect(results.map((result) => result.disposition)).toEqual(['created', 'replayed'])
    expect(prepareAgentSessionSshAccount).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toMatchObject({
      env: expect.objectContaining({ CODEX_HOME: '/remote/profile' }),
      beforeSpawn: assertCurrent
    })
  })

  it('binds the expected host to the operation ID and preserves equivalent object ordering', async () => {
    const { runtime, request, spawn } = fixture()
    await runtime.createAgentSession(request)
    await expect(
      runtime.createAgentSession({
        ...request,
        sshAccountSelection: {
          expectedRuntimeId: runtime.getRuntimeId(),
          expectedHostId: 'ssh:worker',
          policy: 'best-verified'
        }
      })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    await expect(
      runtime.createAgentSession({
        ...request,
        sshAccountSelection: {
          policy: 'best-verified',
          expectedHostId: 'ssh:other',
          expectedRuntimeId: runtime.getRuntimeId()
        }
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('retains an uncertain spawn outcome without reselecting an account on retry', async () => {
    const { runtime, request, spawn } = fixture()
    spawn.mockRejectedValue(
      Object.assign(new Error('receipt lost'), { agentSessionOperationOutcome: 'unknown' })
    )
    await expect(runtime.createAgentSession(request)).rejects.toThrow('receipt lost')
    await expect(runtime.createAgentSession(request)).rejects.toThrow('receipt lost')
    expect(prepareAgentSessionSshAccount).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('refuses the same launch after the controller restarts before account selection or spawning', async () => {
    const original = fixture()
    await original.runtime.createAgentSession(original.request)
    const successor = fixture()
    vi.mocked(prepareAgentSessionSshAccount).mockClear()
    await expect(successor.runtime.createAgentSession(original.request)).rejects.toMatchObject({
      code: 'agent_session_runtime_changed',
      message: expect.stringContaining('restarted or changed'),
      data: {
        expectedRuntimeId: original.runtime.getRuntimeId(),
        runtimeId: successor.runtime.getRuntimeId()
      }
    })
    expect(prepareAgentSessionSshAccount).not.toHaveBeenCalled()
    expect(successor.spawn).not.toHaveBeenCalled()
    expect(original.spawn).toHaveBeenCalledTimes(1)
  })

  it('adopts a local SSH launch without selecting it and keeps the same single spawn on replay', async () => {
    const { runtime, request, spawn } = fixture()
    const visible = { ...request, presentation: 'background' as const, revealInSidebar: true }
    await runtime.createAgentSession(visible)
    await expect(runtime.createAgentSession(visible)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toMatchObject({ presentation: undefined, surfaceOwner: false })
    await expect(
      runtime.createAgentSession({ ...visible, revealInSidebar: false })
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it.each([
    { clientId: 'paired', clientKind: 'runtime' as const },
    { clientKind: 'mobile' as const }
  ])(
    'refuses controller-sidebar adoption from a paired caller before selection or spawn',
    async (caller) => {
      const { runtime, request, spawn } = fixture()
      await expect(
        runtime.createAgentSession({ ...request, revealInSidebar: true }, caller)
      ).rejects.toThrow('Sidebar adoption requires a local')
      expect(prepareAgentSessionSshAccount).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it('fences an SSH folder workspace on the connection its repos give it, as the launch scope does', async () => {
    const folder = {
      id: 'f1',
      projectGroupId: 'g1',
      folderPath: '/remote/notes',
      connectionId: null
    }
    const repos = [
      { id: 'r1', path: '/remote/notes/app', connectionId: 'worker', projectGroupId: 'g1' }
    ]
    const { runtime, request } = fixture({
      getFolderWorkspaces: () => [folder],
      getRepos: () => repos,
      getProjectGroups: () => []
    })
    const scope = {
      id: 'folder:f1',
      path: '/remote/notes',
      connectionId: 'worker',
      repo: null,
      folderWorkspace: folder
    }
    const internals = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internals.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => scope)
    await runtime.createAgentSession(request)
    const { currentWorkspace } = vi.mocked(prepareAgentSessionSshAccount).mock.calls[0]![0]
    expect(currentWorkspace()).toEqual(scope)
    repos.push({ id: 'r2', path: '/remote/notes/web', connectionId: 'other', projectGroupId: 'g1' })
    let error: unknown
    try {
      currentWorkspace()
    } catch (thrown) {
      error = thrown
    }
    expect(error).toMatchObject({
      code: 'agent_session_host_mismatch',
      message: expect.stringContaining('Nothing launched')
    })
  })

  it('keeps prior requests background-only and rejects incompatible sidebar launch modes', async () => {
    const { runtime, request, spawn } = fixture()
    for (const extra of [{ viewMode: 'chat' as const }, { presentation: 'focused' as const }]) {
      await expect(
        runtime.createAgentSession({ ...request, ...extra, revealInSidebar: true })
      ).rejects.toThrow('Sidebar adoption requires a local')
    }
    expect(spawn).not.toHaveBeenCalled()
    await runtime.createAgentSession(request)
    expect(spawn.mock.calls[0]![1]).toMatchObject({ presentation: 'background' })
    expect(spawn.mock.calls[0]![1]).not.toHaveProperty('surfaceOwner')
  })
})

function localFixture(model = 'opus') {
  const base = fixture()
  const internals = base.runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internals.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'workspace',
    path: '/work',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))
  internals.markLocalWorkspaceTrustedForAgent = vi.fn()
  const assertCurrent = vi.fn()
  vi.mocked(prepareAgentSessionLocalAccount).mockResolvedValue({
    env: { CLAUDE_CONFIG_DIR: '/accounts/a/session' },
    assertCurrent,
    receipt: receipt('local'),
    fableVerified: false
  })
  const request: RuntimeCreateAgentSessionRequest = {
    ...base.request,
    agent: 'claude',
    launchPreferences: { model, effort: 'high' },
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: base.runtime.getRuntimeId()
    }
  }
  return { ...base, request, assertCurrent }
}

describe('native local best-verified launch operation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('local best-verified reserves before selecting', async () => {
    const { runtime, request, assertCurrent, spawn } = localFixture()
    const results = await Promise.all([
      runtime.createAgentSession(request),
      runtime.createAgentSession(request)
    ])
    expect(results.map((result) => result.disposition)).toEqual(['created', 'replayed'])
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
    expect(prepareAgentSessionSshAccount).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toMatchObject({
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/accounts/a/session' }),
      beforeSpawn: assertCurrent
    })
    expect(results[0]).toMatchObject({
      account: receipt('local'),
      launch: { model: 'opus', effort: 'high', source: 'request' }
    })
  })

  it('replay returns the same account receipt without selecting again', async () => {
    const { runtime, request, spawn } = localFixture()
    const created = await runtime.createAgentSession(request)
    const replayed = await runtime.createAgentSession(request)
    expect(replayed).toEqual({ ...created, disposition: 'replayed' })
    expect(replayed.account).toEqual(receipt('local'))
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a restarted runtime refuses with agent_session_runtime_changed before selection', async () => {
    const original = localFixture()
    const successor = localFixture()
    await expect(successor.runtime.createAgentSession(original.request)).rejects.toMatchObject({
      code: 'agent_session_runtime_changed',
      data: {
        expectedRuntimeId: original.runtime.getRuntimeId(),
        runtimeId: successor.runtime.getRuntimeId()
      }
    })
    expect(prepareAgentSessionLocalAccount).not.toHaveBeenCalled()
    expect(successor.spawn).not.toHaveBeenCalled()
  })

  it('a pre-spawn refusal frees the ID for a same-ID retry', async () => {
    const { runtime, request, spawn } = localFixture()
    vi.mocked(prepareAgentSessionLocalAccount).mockRejectedValueOnce(
      agentLaunchRefusal('agent_session_account_unverified', 'No fresh account. Nothing launched.')
    )
    await expect(runtime.createAgentSession(request)).rejects.toMatchObject({
      code: 'agent_session_account_unverified'
    })
    expect(spawn).not.toHaveBeenCalled()
    await expect(runtime.createAgentSession(request)).resolves.toMatchObject({
      disposition: 'created'
    })
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('refuses a resolved Fable model whose window was not verified before spawn', async () => {
    const { runtime, request, spawn } = localFixture('claude-fable-1')
    await expect(runtime.createAgentSession(request)).rejects.toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining('Fable window was not verified')
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('an unknown spawn outcome keeps the fence', async () => {
    const { runtime, request, spawn } = localFixture()
    spawn.mockRejectedValue(
      Object.assign(new Error('receipt lost'), { agentSessionOperationOutcome: 'unknown' })
    )
    await expect(runtime.createAgentSession(request)).rejects.toThrow('receipt lost')
    await expect(runtime.createAgentSession(request)).rejects.toThrow('receipt lost')
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("gives the picker the runtime's WSL check for the workspace", async () => {
    const { runtime, request } = localFixture()
    await runtime.createAgentSession(request)
    const { runsInWsl } = vi.mocked(prepareAgentSessionLocalAccount).mock.calls[0]![0]
    const target = {
      id: 'workspace',
      path: '/work',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }
    expect(runsInWsl(target)).toBe(false)
    expect(runsInWsl({ ...target, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\work' })).toBe(true)
  })

  it('ssh: fingerprints are byte-identical to before', async () => {
    const { runtime, request } = fixture()
    await runtime.createAgentSession(request)
    const ledger = (
      runtime as unknown as {
        agentSessionCreateOperations: Map<string, { fingerprint: string }>
      }
    ).agentSessionCreateOperations
    // Why literal: the tuple old CLIs and omni-launch-best replay against must not move.
    const before = createHash('sha256')
      .update(
        JSON.stringify([
          'id:workspace',
          'codex',
          'Do the work',
          null,
          null,
          'host-default',
          'pinned-model',
          'high',
          null,
          null,
          null,
          null,
          null,
          'terminal',
          ['best-verified', 'ssh:worker', runtime.getRuntimeId()]
        ])
      )
      .digest('base64url')
    expect(ledger.get(`trusted-local:runtime\0${request.clientOperationId}`)?.fingerprint).toBe(
      before
    )
  })

  it('a paired caller (clientKind runtime) launches local without revealInSidebar', async () => {
    const { runtime, request, spawn } = localFixture()
    await expect(
      runtime.createAgentSession(request, { clientId: 'paired-device', clientKind: 'runtime' })
    ).resolves.toMatchObject({ disposition: 'created', account: receipt('local') })
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toMatchObject({ presentation: 'background' })
    expect(spawn.mock.calls[0]![1]).not.toHaveProperty('surfaceOwner')
  })
})
