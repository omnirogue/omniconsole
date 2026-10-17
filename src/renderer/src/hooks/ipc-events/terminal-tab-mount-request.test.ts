import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: main asks for a tab mount for every runtime subscribe of a tab without a PTY, including a
// paired desktop client that subscribes each tab it mounts. Only the phone's own per-terminal
// open is a person opening that tab, so only it may release an agent the flood guard holds.

const mocks = vi.hoisted(() => ({
  requestBackgroundTerminalWorktreeMount: vi.fn(),
  revealTerminalTabForPerson: vi.fn(),
  hasRegisteredRuntimeTerminalTab: vi.fn(() => false),
  planMobileTerminalTabMount: vi.fn(
    (_state: unknown, request: { worktreeId: string; tabId?: string }) =>
      request.tabId ? { worktreeId: request.worktreeId, tabIds: [request.tabId] } : null
  )
}))

vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.requestBackgroundTerminalWorktreeMount
}))
vi.mock('@/components/terminal-pane/pty-connection/cold-restore-reveal-hold', () => ({
  revealTerminalTabForPerson: mocks.revealTerminalTabForPerson
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  hasRegisteredRuntimeTerminalTab: mocks.hasRegisteredRuntimeTerminalTab
}))
vi.mock('@/lib/mobile-terminal-tab-mount', () => ({
  planMobileTerminalTabMount: mocks.planMobileTerminalTabMount
}))
const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => storeState.current } }))

describe('renderer terminal tab mount requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.current = {}
  })

  it("reveals the tab for a person only on the phone's own open", async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')

    handleTerminalTabMountRequest({ worktreeId: 'wt-1', tabId: 'tab-1', personOpen: true })

    expect(mocks.revealTerminalTabForPerson).toHaveBeenCalledTimes(1)
    expect(mocks.revealTerminalTabForPerson).toHaveBeenCalledWith('tab-1')
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-1']
    })
  })

  it('mounts without releasing any hold for a paired-client or replayed subscribe', async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')

    for (const tabId of ['tab-1', 'tab-2', 'tab-3']) {
      handleTerminalTabMountRequest({ worktreeId: 'wt-1', tabId })
    }

    expect(mocks.revealTerminalTabForPerson).not.toHaveBeenCalled()
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledTimes(3)
  })

  it('ignores a request without a workspace', async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')
    handleTerminalTabMountRequest({ worktreeId: '', tabId: 'tab-1', personOpen: true })
    expect(mocks.revealTerminalTabForPerson).not.toHaveBeenCalled()
    expect(mocks.requestBackgroundTerminalWorktreeMount).not.toHaveBeenCalled()
  })
})

// Why: main awaits this acknowledgement before telling a paired caller a surface is opening, so
// a dropped request or a missing tab is reported instead of becoming an invisible process (C3).
describe('acknowledged mount requests', () => {
  const LEAF = '11111111-1111-4111-8111-111111111111'
  const reply = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasRegisteredRuntimeTerminalTab.mockReset().mockReturnValue(false)
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { ui: { replyTerminalTabMount: reply } } })
    storeState.current = {
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      terminalLayoutsByTabId: { 'tab-1': { root: { type: 'leaf', leafId: LEAF } } }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('acknowledges the exact surface once its pane is mounted', async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValueOnce(false).mockReturnValueOnce(false)

    handleTerminalTabMountRequest({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF,
      requestId: 'req-1'
    })
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-1']
    })
    expect(reply).not.toHaveBeenCalled()
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(200)

    expect(reply).toHaveBeenCalledWith({
      requestId: 'req-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF,
      outcome: 'mounted'
    })
  })

  it('refuses a tab or leaf the window does not have, mounting nothing', async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')

    handleTerminalTabMountRequest({ worktreeId: 'wt-1', tabId: 'gone', requestId: 'req-2' })
    handleTerminalTabMountRequest({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: '22222222-2222-4222-8222-222222222222',
      requestId: 'req-3'
    })

    expect(reply.mock.calls.map(([sent]) => sent.outcome)).toEqual([
      'tab_not_found',
      'leaf_not_found'
    ])
    expect(mocks.requestBackgroundTerminalWorktreeMount).not.toHaveBeenCalled()
  })

  it('reports a mount that never lands as a timeout', async () => {
    const { handleTerminalTabMountRequest } = await import('./terminal-tab-mount-request')

    handleTerminalTabMountRequest({ worktreeId: 'wt-1', tabId: 'tab-1', requestId: 'req-4' })
    await vi.advanceTimersByTimeAsync(5_100)

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'mount_timeout' }))
  })
})
