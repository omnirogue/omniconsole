import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { OrcaRuntimeService } from './omni-runtime'
import { prepareAgentSessionLocalAccount } from './agent-session-local-account'
import { prepareManagedSessionTools } from './managed-session-tools'

vi.mock('./agent-session-local-account', () => ({
  prepareAgentSessionLocalAccount: vi.fn(),
  previewLocalLaunchAccount: vi.fn()
}))
vi.mock('./managed-session-tools', () => ({ prepareManagedSessionTools: vi.fn() }))

function fixture(platform = 'darwin') {
  vi.stubGlobal('process', { ...process, platform })
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    })
  } as never)
  const internals = runtime as unknown as Record<string, unknown>
  internals.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'workspace',
    path: '/workspace',
    connectionId: null
  }))
  internals.executionOwnerSupportsAgentSessionOperation = vi.fn(async () => true)
  internals.markLocalWorkspaceTrustedForAgent = vi.fn()
  const accountFence = vi.fn()
  const fileFence = vi.fn()
  vi.mocked(prepareAgentSessionLocalAccount).mockResolvedValue({
    env: { CLAUDE_CONFIG_DIR: '/selected/account' },
    assertCurrent: accountFence,
    fableVerified: false,
    receipt: {
      policy: 'best-verified',
      hostId: 'local',
      provider: 'claude',
      label: 'Fixture account',
      choiceId: 'fixture',
      remainingPercent: 90,
      boundBy: 'weekly',
      readingAt: Date.now(),
      readingAgeMs: 0,
      fableVerified: false,
      verified: 1,
      considered: 1,
      excluded: [],
      why: 'fixture'
    }
  })
  const operationId = `${Date.now()}-0123456789abcdef0123456789abcdef`
  vi.mocked(prepareManagedSessionTools).mockResolvedValue({
    descriptor: {
      schema: 'native-session-tools.v1',
      operation_id: 'external-op',
      native_operation_id: operationId,
      provider: 'claude',
      command: '/usr/bin/python3',
      args: ['/private/shim', '/private/config'],
      principal: { clerk_user_id: 'user_eve', employee_id: 'emp_eve' }
    },
    mcpConfigPath: '/private/mcp',
    writeMcpConfig: vi.fn(),
    assertCurrent: fileFence,
    command: '/verified/claude',
    environment: {},
    agentArgs: '--dangerously-skip-permissions --strict-mcp-config --mcp-config /private/mcp',
    seededProviderSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    gateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ptyId: 'pty-original',
    incarnationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    pid: 120,
    processStartTimeMs: Date.now() - 100,
    processKind: 'pty-shell',
    reportsChildExitStatus: true,
    ptyRootPid: 119,
    ptyRootProcessStartTimeMs: Date.now() - 200,
    exitObserver: 'macos-kqueue',
    startupCommandMode: 'exec'
  }
  let token: string | undefined
  const spawn = vi
    .spyOn(runtime, 'createTerminal')
    .mockImplementation(async (_workspace, options) => {
      options?.beforeSpawn?.()
      token = options?.launchToken
      options?.onPtySpawnCommitted?.()
      return {
        handle: 'term_original',
        ptyId: gate.ptyId,
        paneKey: 'tab:leaf',
        worktreeId: 'workspace',
        title: null,
        launchGate: gate
      }
    })
  internals.readManagedSessionTerminal = vi.fn(() => ({
    handle: 'term_original',
    paneKey: 'tab:leaf',
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    launchToken: token
  }))
  const release = vi
    .spyOn(runtime, 'releaseTerminalLaunchGate')
    .mockImplementation(async (_handle, request) => ({
      gateId: gate.gateId,
      state: 'released',
      startAcknowledgement: request.startAcknowledgement
    }))
  const request: RuntimeCreateAgentSessionRequest = {
    clientOperationId: operationId,
    worktree: 'id:workspace',
    agent: 'claude',
    prompt: 'Do authorized work',
    viewMode: 'terminal',
    managedToolsFile: '/private/descriptor',
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: runtime.getRuntimeId()
    }
  }
  const stop = vi.fn(async () => true)
  internals.stopExplicitlyClosedTabPtys = stop
  return { runtime, request, spawn, release, accountFence, fileFence, stop }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('native managed session launch boundary', () => {
  it.each(['linux', 'win32'])(
    'refuses managed launch on unsupported %s hosts',
    async (platform) => {
      const f = fixture(platform)
      await expect(f.runtime.createAgentSession(f.request)).rejects.toThrow(
        'managed_session_tools_local_verified_fresh_launch_required'
      )
      expect(prepareAgentSessionLocalAccount).not.toHaveBeenCalled()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  )

  it('pins host account/defaults, fences before spawn, releases the fresh gate once and replays', async () => {
    const f = fixture()
    const first = await f.runtime.createAgentSession(f.request)
    expect(first.disposition).toBe('created')
    expect(f.accountFence).toHaveBeenCalledOnce()
    expect(f.fileFence).toHaveBeenCalledOnce()
    expect(prepareManagedSessionTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agentArgs: '--dangerously-skip-permissions',
        selectedAccountEnv: { CLAUDE_CONFIG_DIR: '/selected/account' }
      })
    )
    const options = f.spawn.mock.calls[0][1]!
    expect(options.tabId).toBeUndefined()
    expect(options.leafId).toBeUndefined()
    expect(options.launchGate).toMatchObject({
      startupCommandMode: 'exec',
      processObservation: 'required'
    })
    expect(options.command).toContain('--session-id')
    expect(options.launchConfig?.agentCommand).not.toContain('--session-id')
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/selected/account')
    expect(f.release).toHaveBeenCalledOnce()
    expect(await f.runtime.createAgentSession(f.request)).toMatchObject({ disposition: 'replayed' })
    expect(f.spawn).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('refuses replacement arguments and direct SSH ownership before selecting or spawning', async () => {
    const f = fixture()
    await expect(
      f.runtime.createAgentSession({ ...f.request, agentArgs: '--other' })
    ).rejects.toThrow('managed_session_tools_local_verified_fresh_launch_required')
    expect(prepareAgentSessionLocalAccount).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('stops only its owned fresh PTY when the gate release fails', async () => {
    const f = fixture()
    f.release.mockRejectedValue(new Error('release failed'))
    await expect(f.runtime.createAgentSession(f.request)).rejects.toThrow('release failed')
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(['pty-original'], 'pty-original')
    await expect(f.runtime.createAgentSession(f.request)).rejects.toThrow('release failed')
    expect(f.spawn).toHaveBeenCalledOnce()
  })

  it('does not reinterpret an unknown operation as the latest pane', async () => {
    const f = fixture()
    expect(await f.runtime.inspectAgentSessionLaunch(f.request.clientOperationId)).toMatchObject({
      authority_verified: false,
      state: 'unverifiable'
    })
    expect(f.spawn).not.toHaveBeenCalled()
  })
})
