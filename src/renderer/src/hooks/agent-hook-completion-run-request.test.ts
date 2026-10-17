import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatchTerminalNotification = vi.fn()
const HOOK_DONE_QUIET_MS = 1_500
const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

const mockStoreState = {
  settings: {
    experimentalTerminalAttention: false,
    notifications: { enabled: true, agentTaskComplete: true }
  },
  ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
  suppressedPtyExitIds: {},
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
  terminalLayoutsByTabId: {},
  agentLaunchConfigByPaneKey: {},
  agentStatusByPaneKey: {},
  getAgentLaunchConfigForStatusEntry: () => undefined,
  getAgentLaunchConfigForStatusMetadata: () => undefined
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => mockStoreState } }))
vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))
vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle: vi.fn()
}))

/** A Claude permission pause: the hook's own "needs input" for this pane. */
async function observePermissionPause(): Promise<void> {
  const { observeAgentHookCompletionForNotification } =
    await import('./agent-hook-completion-notifications')
  observeAgentHookCompletionForNotification({
    paneKey,
    worktreeId: 'wt-1',
    payload: {
      state: 'working',
      prompt: 'edit package.json',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    }
  })
  observeAgentHookCompletionForNotification({
    paneKey,
    worktreeId: 'wt-1',
    payload: {
      state: 'waiting',
      prompt: 'edit package.json',
      agentType: 'claude',
      toolName: 'Edit',
      toolInput: 'package.json',
      stateStartedAt: 1_700_000_010_000
    }
  })
  vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
}

describe('a pane whose run already carries the request', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  it('does not ring a second time: the host announced that request once', async () => {
    const { setSessionRunRequestProbe } = await import('@/lib/session-run-request-probe')
    const asked: string[] = []
    setSessionRunRequestProbe((key) => {
      asked.push(key)
      return true
    })
    await observePermissionPause()
    expect(asked).toEqual([paneKey])
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('still rings for an ordinary pane, and when no run holds a request for it', async () => {
    const { setSessionRunRequestProbe } = await import('@/lib/session-run-request-probe')
    setSessionRunRequestProbe(() => false)
    await observePermissionPause()
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({ state: 'waiting' })
      })
    )
  })
})
