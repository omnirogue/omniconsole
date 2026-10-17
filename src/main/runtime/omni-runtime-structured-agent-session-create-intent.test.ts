import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import * as newSessionDefaults from './new-agent-session-defaults-host'

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    const defaults = vi
      .spyOn(newSessionDefaults, 'resolveNewAgentSessionDefaultsOnHost')
      .mockResolvedValue({ model: 'gpt-6.1-sol', effort: 'medium' })
    try {
      const fresh = await runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'fresh-session', clientOperationId: 'fresh-operation' },
        worktree: 'id:workspace-1',
        agent: 'codex',
        applyNewSessionDefaults: true
      })
      expect(fresh.options).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' })
      expect(defaults).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          accountHome: '/accounts/selected/home',
          workspacePath: '/repos/workspace-1',
          env: expect.objectContaining({ CODEX_HOME: '/configured/home' })
        })
      )
    } finally {
      defaults.mockRestore()
    }
  })
})

describe('structured agent-session create intent options', () => {
  it('carries launch-time model and effort into the attach params', async () => {
    const runtime = new OrcaRuntimeService(
      { getSettings: () => ({ agentDefaultEnv: {} }) } as never,
      undefined,
      { prepareCodexStructuredLaunch: vi.fn(() => '/accounts/selected/home') }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<unknown>
      resolveRuntimeFileTarget: (selector: string) => Promise<{ worktree: { path: string } }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex',
      options: { model: 'gpt-6-astra', effort: 'xhigh' }
    })
    expect(intent.options).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })

    const bare = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-2', clientOperationId: 'operation-2' },
      worktree: 'id:workspace-1',
      agent: 'codex',
      options: {}
    })
    expect(bare).not.toHaveProperty('options')
  })
})

describe('Claude SDK create intent routing', () => {
  function setup(configDir?: string) {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          experimentalStructuredNativeChat: true,
          agentUseAcp: {},
          agentDefaultEnv: configDir ? { claude: { CLAUDE_CONFIG_DIR: configDir } } : {}
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    const support = vi
      .spyOn(runtime, 'getStructuredAgentSessionCreateSupport')
      .mockResolvedValue({ supported: true })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<unknown>
      resolveRuntimeFileTarget: (selector: string) => Promise<{ worktree: { path: string } }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/folders/workspace-1' }
    }))
    const getRuntimeConfigDir = vi.fn(() => '/accounts/claude/host')
    runtime.setAccountServices({ claudeAccounts: { getRuntimeConfigDir } } as never)
    return { runtime, support, getRuntimeConfigDir, prepareCodexStructuredLaunch }
  }

  const request = {
    envelope: { sessionId: 'claude-1', clientOperationId: 'operation-claude-1' },
    worktree: 'id:workspace-1',
    agent: 'claude' as const,
    options: { model: 'claude-opus-4-6', chatPermissionMode: 'bypass' }
  }

  it('uses the offered SDK lane and pins the host account without requiring ACP', async () => {
    const { runtime, support, getRuntimeConfigDir, prepareCodexStructuredLaunch } = setup()
    const intent = await runtime.resolveStructuredAgentSessionCreateIntent(request)

    expect(support).toHaveBeenCalledWith(request.worktree, 'claude')
    expect(getRuntimeConfigDir).toHaveBeenCalledWith({ runtime: 'host' })
    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(intent).toMatchObject({
      agent: 'claude',
      provider: 'claude',
      location: { workspaceKind: 'folder', workspaceId: 'workspace-1' },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude/host' },
      options: request.options
    })
    expect(intent.options).not.toHaveProperty('transport')
  })

  it('preserves a configured Claude home for the existing launch auth policy to validate', async () => {
    const { runtime, getRuntimeConfigDir } = setup('/configured/claude')
    const intent = await runtime.resolveStructuredAgentSessionCreateIntent(request)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude'
    })
    expect(getRuntimeConfigDir).not.toHaveBeenCalled()
  })

  it('keeps an explicit ACP request on its own disabled transport', async () => {
    const { runtime, support, getRuntimeConfigDir } = setup()
    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        ...request,
        options: { ...request.options, transport: 'acp' }
      })
    ).rejects.toThrow('ACP is disabled')
    expect(support).not.toHaveBeenCalled()
    expect(getRuntimeConfigDir).not.toHaveBeenCalled()
  })

  it('retains host and account support refusals before resolving a credential root', async () => {
    const { runtime, support, getRuntimeConfigDir } = setup()
    support.mockResolvedValue({ supported: false, reason: 'wsl' })
    await expect(runtime.resolveStructuredAgentSessionCreateIntent(request)).rejects.toThrow(
      'structured_agent_session_unsupported'
    )
    expect(getRuntimeConfigDir).not.toHaveBeenCalled()
  })
})
