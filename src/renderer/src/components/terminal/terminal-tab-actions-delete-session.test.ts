import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

import { closeTerminalTab } from './terminal-tab-actions'

/** A delete must reach the store's retirement plan on every path, so the pane's PTY ends. */
describe('closeTerminalTab deleteSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('carries a delete through to the store when the tab row is already gone', () => {
    const closeTab = vi.fn()
    getStateMock.mockReturnValue({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      closeTab
    })

    closeTerminalTab('deleted-tab', { reason: 'user', deleteSession: true })

    expect(closeTab).toHaveBeenCalledWith('deleted-tab', { reason: 'user', deleteSession: true })
  })

  it('carries a delete through to the store for a local terminal tab', () => {
    const closeTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            entityId: 'terminal-entity-1',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
      closeTab,
      closeUnifiedTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1', {
      reason: 'user',
      captureRecentlyClosed: true,
      skipRunningProcessConfirm: true,
      deleteSession: true
    })

    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', {
      reason: 'user',
      captureRecentlyClosed: true,
      deleteSession: true
    })
  })
})
