import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const launchAgentInNewTab = vi.hoisted(() => vi.fn())
const connectionId = vi.hoisted(() => ({ value: null as string | null | undefined }))
const runtimeEnvironmentId = vi.hoisted(() => ({ value: null as string | null }))
const localContext = vi.hoisted(() => ({ value: undefined as unknown }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const store = vi.hoisted(() => ({
  settings: { disabledTuiAgents: [] as string[] },
  ensureDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRemoteDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRuntimeDetectedAgents: vi.fn(async () => ['claude', 'codex'])
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => connectionId.value
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => runtimeEnvironmentId.value
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalAgentPreflightContext: () => localContext.value
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, value),
      fallback
    )
}))

describe('launchAgentSessionContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionId.value = null
    runtimeEnvironmentId.value = null
    localContext.value = undefined
    store.settings.disabledTuiAgents = []
    store.ensureDetectedAgents.mockResolvedValue(['claude', 'codex'])
    store.ensureRemoteDetectedAgents.mockResolvedValue(['claude', 'codex'])
    store.ensureRuntimeDetectedAgents.mockResolvedValue(['claude', 'codex'])
    launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-new',
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    vi.stubGlobal('window', {
      api: { agentTrust: { markTrusted: vi.fn(async () => undefined) } }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['discovery', 'trust'] as const)(
    'does not create a tab when cancelled during %s',
    async (stage) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const atBoundary = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = async (): Promise<void> => {
        entered()
        await gate
      }
      if (stage === 'discovery') {
        store.ensureDetectedAgents.mockImplementationOnce(async () => {
          await wait()
          return []
        })
      } else {
        vi.stubGlobal('window', { api: { agentTrust: { markTrusted: vi.fn(wait) } } })
      }
      let allowed = true
      const onLaunched = vi.fn()
      const result = launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'Continue the queued step',
        worktreeId: 'wt-1',
        workspacePath: '/repo',
        launchSource: 'sidebar',
        shouldLaunch: () => allowed,
        onLaunched
      })
      await atBoundary
      allowed = false
      release()

      await expect(result).resolves.toBe(false)
      expect(launchAgentInNewTab).not.toHaveBeenCalled()
      expect(onLaunched).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    }
  )

  it('launches any detected target Agent in the same workspace and cwd', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue the unfinished task',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        workspacePath: '/repo/worktree',
        initialCwd: '/repo/worktree/packages/app',
        launchSource: 'terminal_context_menu'
      })
    ).resolves.toBe(true)

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        initialCwd: '/repo/worktree/packages/app',
        viewModePreference: 'chat',
        promptDelivery: 'submit-after-ready'
      })
    )
  })

  it.each([
    { connection: 'ssh-1', runtime: null, context: undefined },
    { connection: 'runtime:host/ssh:target', runtime: 'host', context: undefined },
    { connection: null, runtime: 'paired-host', context: undefined },
    { connection: undefined, runtime: null, context: undefined },
    { connection: null, runtime: null, context: { wslDistro: 'Ubuntu' } },
    { connection: null, runtime: null, context: { projectRuntime: { status: 'repair-required' } } }
  ])('does not automatically select Chat for an unproven reader: %j', async (owner) => {
    connectionId.value = owner.connection
    runtimeEnvironmentId.value = owner.runtime
    localContext.value = owner.context
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    expect(
      await launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId: 'wt-1',
        workspacePath: '/repo/worktree',
        launchSource: 'sidebar'
      })
    ).toBe(true)
    expect(launchAgentInNewTab.mock.calls[0][0]).not.toHaveProperty('viewModePreference')
  })

  it('detects the target Agent on the SSH host that owns the workspace', async () => {
    connectionId.value = 'ssh-1'
    const { detectAgentSessionContinuationAgents } =
      await import('./launch-agent-session-continuation')

    await expect(detectAgentSessionContinuationAgents('wt-1')).resolves.toEqual(['claude', 'codex'])
    expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('detects local Agents in the target worktree runtime', async () => {
    const { detectAgentSessionContinuationAgents } =
      await import('./launch-agent-session-continuation')

    await detectAgentSessionContinuationAgents('wt-1')

    expect(store.ensureDetectedAgents).toHaveBeenCalledWith('wt-1')
  })

  it('stops before launch when the selected Agent is unavailable', async () => {
    store.ensureDetectedAgents.mockResolvedValue(['claude'])
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'codex',
        prompt: 'continue',
        worktreeId: 'wt-1',
        workspacePath: '/repo/worktree',
        launchSource: 'sidebar'
      })
    ).resolves.toBe(false)

    expect(launchAgentInNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Codex was not detected on this workspace host.')
  })

  it('distinguishes prompt delivery failure from terminal launch failure', async () => {
    launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-new',
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue',
      worktreeId: 'wt-1',
      workspacePath: '/repo/worktree',
      launchSource: 'sidebar'
    })

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The new Codex session started, but its context could not be sent.'
      )
    )
  })
  it('refuses unsupported model effort before any tab exists', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId: 'wt-1',
        workspacePath: '/repo',
        launchSource: 'sidebar',
        launchPreferences: { model: 'haiku', effort: 'low' }
      })
    ).resolves.toBe(false)

    expect(launchAgentInNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Could not start Claude: Agent claude model haiku does not support effort low.'
    )
  })

  it.each(['low', 'max'])(
    'forwards terminal effort %s without choosing a model',
    async (effort) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

      await expect(
        launchAgentSessionContinuation({
          agent: 'claude',
          prompt: 'continue',
          worktreeId: 'wt-1',
          workspacePath: '/repo',
          launchSource: 'sidebar',
          viewModePreference: 'terminal',
          launchPreferences: { effort }
        })
      ).resolves.toBe(true)

      expect(launchAgentInNewTab).toHaveBeenCalledWith(
        expect.objectContaining({ viewModePreference: 'terminal', launchPreferences: { effort } })
      )
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it('forwards a valid actor and its session-only env to the launch', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId: 'wt-1',
        workspacePath: '/repo',
        launchSource: 'sidebar',
        launchPreferences: { model: 'opus', effort: 'max' },
        launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/second/auth' }
      })
    ).resolves.toBe(true)

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        launchPreferences: { model: 'opus', effort: 'max' },
        launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/second/auth' }
      })
    )
  })

  it('preserves an explicit Terminal source and reports a failed async launch receipt', async () => {
    launchAgentInNewTab.mockReturnValue({
      tabId: null,
      launchCompletion: Promise.resolve(false),
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    let delivered: Promise<boolean> | undefined
    await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue',
      worktreeId: 'wt-1',
      workspacePath: '/repo',
      launchSource: 'workflow_follow_up',
      viewModePreference: 'terminal',
      onLaunched: (result) => {
        delivered = result.promptDelivered
      }
    })
    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        viewModePreference: 'terminal',
        launchSource: 'workflow_follow_up'
      })
    )
    await expect(delivered).resolves.toBe(false)
  })
})
