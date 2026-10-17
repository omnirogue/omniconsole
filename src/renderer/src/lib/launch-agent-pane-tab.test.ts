import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  queue: vi.fn(),
  mount: vi.fn(),
  navigate: vi.fn(),
  deliver: vi.fn(),
  published: vi.fn(),
  receipt: vi.fn(),
  order: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { agentDefaultArgs: {}, agentDefaultEnv: {}, agentCmdOverrides: {} },
      getKnownWorktreeById: () => ({ id: 'wt', repoId: 'repo', path: '/repo' }),
      repos: [{ id: 'repo', path: '/repo' }],
      worktreesByRepo: { repo: [{ id: 'wt', repoId: 'repo', path: '/repo' }] },
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: { wt: [] },
      createTab: mocks.create,
      queueTabStartupCommand: mocks.queue,
      setActiveTabType: mocks.navigate,
      setTabBarOrder: mocks.order,
      tabBarOrderByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {}
    })
  }
}))
vi.mock('@/store/terminals/terminal-workspace-routing', () => ({
  tryTerminalCreationRoute: () => ({ runtimeEnvironmentId: null, connectionId: null })
}))
vi.mock('./conversation-launch-reservation', () => ({
  conversationLaunchReservationIsCurrent: () => true
}))
vi.mock('@/lib/agent-launch-platform', () => ({ getAgentLaunchPlatformForRepo: () => 'darwin' }))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => null
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('./launch-agent-acp-attempt', () => ({
  attemptAcpChatLaunch: () => null,
  shouldAttemptAcpChatLaunch: () => false
}))
vi.mock('./launch-agent-claude-structured-attempt', () => ({
  attemptClaudeStructuredChatLaunch: () => null,
  shouldAttemptClaudeStructuredLaunch: () => false
}))
vi.mock('./launch-agent-codex-structured-attempt', () => ({
  attemptCodexStructuredChatLaunch: () => null
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.mount
}))
vi.mock('@/lib/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliver,
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))
vi.mock('./launch-agent-in-new-tab-order', () => ({ appendLaunchedTabOrder: mocks.order }))
vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: () => ({ onTimeout: vi.fn(), wasNotified: () => false })
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockReturnValue({ id: 'submission' })
  mocks.deliver.mockResolvedValue(true)
})
describe('a ready-pane PTY launch stays in the grid', () => {
  it('queues before waking only its own tab and waits for the prompt receipt', async () => {
    let accept!: (delivered: boolean) => void
    mocks.deliver.mockReturnValue(
      new Promise<boolean>((resolve) => {
        accept = resolve
      })
    )
    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt',
      navigate: false,
      tabId: 'submission',
      submissionId: 'submission',
      prompt: 'Task',
      promptDelivery: 'submit-after-ready',
      onSessionCreated: mocks.published,
      onPromptDelivered: mocks.receipt
    })
    expect(mocks.create).toHaveBeenCalledWith(
      'wt',
      undefined,
      undefined,
      expect.objectContaining({ id: 'submission', activate: false, launchAgent: 'codex' })
    )
    expect(mocks.mount).toHaveBeenCalledWith({ worktreeId: 'wt', tabIds: ['submission'] })
    expect(mocks.queue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mount.mock.invocationCallOrder[0]
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.published).toHaveBeenCalledWith('submission')
    expect(mocks.receipt).not.toHaveBeenCalled()
    accept(true)
    await expect(result?.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.receipt).toHaveBeenCalledOnce()
  })
  it('leaves ordinary launcher activation and mounting behavior intact', () => {
    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt' })
    expect(mocks.create.mock.calls[0][3]).not.toHaveProperty('activate')
    expect(mocks.mount).not.toHaveBeenCalled()
    expect(mocks.navigate).toHaveBeenCalledWith('terminal')
  })
})
