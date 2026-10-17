import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueueTabStartupCommand = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [{ id: 'wt-1', connectionId: null }],
  worktreesByRepo: {},
  allWorktrees: vi.fn(() => []),
  getKnownWorktreeById: vi.fn(() => undefined),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: () => false
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: vi.fn(async () => true),
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))

describe('launchAgentInNewTab actor preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings.agentDefaultArgs = {}
    store.settings.agentDefaultEnv = {}
  })

  it('applies a per-launch model and effort plus a session-only account env', async () => {
    store.settings.agentDefaultArgs = { claude: '--model sonnet --dangerously-skip-permissions' }
    store.settings.agentDefaultEnv = { claude: { OMNI_YOLO: '1' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'improve the research notes',
      promptDelivery: 'submit-after-ready',
      launchPreferences: { model: 'opus', effort: 'max' },
      launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/second/auth' }
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        // Why: the explicit actor replaces the default `--model sonnet`; other default args survive,
        // and `command` keeps a shell function from re-pinning the chosen account.
        command:
          "command claude '--dangerously-skip-permissions' '--model' 'opus' '--effort' 'max'",
        env: { OMNI_YOLO: '1', CLAUDE_CONFIG_DIR: '/accounts/second/auth' },
        sessionOptions: { model: 'opus', effort: 'max' }
      })
    )
  })

  it('leaves the launch command untouched when no actor preferences are given', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'plain continuation',
      promptDelivery: 'submit-after-ready',
      launchPreferences: null,
      launchEnv: null
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ command: "claude '--dangerously-skip-permissions'", env: {} })
    )
  })

  it('creates the tab under a requested id so the caller can find it later', async () => {
    store.createTab.mockReturnValueOnce({ id: 'brief-tab' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'work from the approved brief',
      tabId: 'brief-tab'
    })

    expect(store.createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ id: 'brief-tab', launchAgent: 'claude' })
    )
    expect(result?.tabId).toBe('brief-tab')
  })
})
