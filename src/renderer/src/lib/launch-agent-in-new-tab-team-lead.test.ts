import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercises the real launch → delivery path for a Claude Agent Teams lead; only the
// PTY paste transport and the store are stubbed.
const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  createTab: vi.fn(),
  queueTabStartupCommand: vi.fn()
}))

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: true
  },
  repos: [{ id: 'wt-1', connectionId: null }],
  worktreesByRepo: {},
  allWorktrees: vi.fn(() => []),
  getKnownWorktreeById: vi.fn(() => undefined),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: mocks.createTab,
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: mocks.queueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
  seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: () => ({ onTimeout: vi.fn(), wasNotified: () => false })
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

describe('launchAgentInNewTab for a Claude Agent Teams lead', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createTab.mockReturnValue({ id: 'tab-1' })
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('opens in chat and submits the team prompt exactly once when the lead is ready', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'You lead this work.\nStart every worker on the same model.\n\nRequest:\nShip it'

    const result = launchAgentInNewTab({
      agent: 'claude-agent-teams',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'submit-after-ready',
      viewModePreference: 'chat'
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'claude-agent-teams', viewMode: 'chat' })
    )
    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ command: expect.not.stringContaining('Ship it') })
    )
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude-agent-teams',
        content: prompt,
        submit: true,
        forcePaste: true
      })
    )
    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: prompt,
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('keys a remaining draft launch under Claude so the lead chat composer adopts it', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude-agent-teams',
      worktreeId: 'wt-1',
      prompt: 'Line one\nLine two',
      viewModePreference: 'chat'
    })

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ viewMode: 'chat' })
    )
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude-agent-teams', submit: false })
    )
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'Line one\nLine two',
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })
})
