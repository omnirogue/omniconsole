import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { startTerminalTabProviderRetirement } from './terminals/terminal-tab-close-providers'
import { createStoreCascadesMockApi } from './slices/store-cascades-test-harness'
import { createTestStore, makeTabGroup, makeWorktree, seedStore } from './slices/store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

vi.mock('./terminals/terminal-tab-close-providers', () => ({
  startTerminalTabProviderRetirement: vi.fn()
}))

const mockApi = createStoreCascadesMockApi()
const WORKTREE = 'repo1::/repo1/app'
const OTHER_WORKTREE = 'repo1::/repo1/other'
const LIVE_TAB = 'live-tab'
const DRAFT_TAB = 'conversation-draft'
const LIVE_GROUP = 'live-group'
const DRAFT_GROUP = 'draft-group'

function createReservedSplitStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/app' }),
        makeWorktree({ id: OTHER_WORKTREE, repoId: 'repo1', path: '/repo1/other' })
      ]
    },
    activeWorktreeId: WORKTREE,
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({ id: LIVE_GROUP, worktreeId: WORKTREE }),
        makeTabGroup({ id: DRAFT_GROUP, worktreeId: WORKTREE })
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE]: LIVE_GROUP },
    layoutByWorktree: {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.6,
        first: { type: 'leaf', groupId: LIVE_GROUP },
        second: { type: 'leaf', groupId: DRAFT_GROUP }
      }
    }
  })
  store.getState().createTab(WORKTREE, LIVE_GROUP, undefined, {
    id: LIVE_TAB,
    initialPtyId: 'live-pty'
  })
  store.getState().createTab(WORKTREE, DRAFT_GROUP, undefined, {
    id: DRAFT_TAB,
    conversationLaunchPending: true
  })
  return store
}

describe('conversation terminal tab reservations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replaces the sole draft in a split atomically, preserving its group and selection', () => {
    const store = createReservedSplitStore()
    const before = store.getState()
    const snapshots: ReturnType<typeof store.getState>[] = []
    const unsubscribe = store.subscribe((state) => snapshots.push(state))

    const launched = store.getState().createTab(WORKTREE, DRAFT_GROUP, undefined, {
      id: DRAFT_TAB,
      replaceConversationDraft: true,
      pendingStartup: { command: 'codex', draftPrompt: 'Review the changes' },
      viewMode: 'chat',
      recordInteraction: false
    })
    unsubscribe()

    expect(snapshots).toHaveLength(1)
    const after = snapshots[0]
    expect(launched.id).toBe(DRAFT_TAB)
    expect(launched.conversationLaunchPending).toBeUndefined()
    expect(after.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([LIVE_TAB, DRAFT_TAB])
    expect(after.tabsByWorktree[WORKTREE][1]).toBe(launched)
    expect(after.groupsByWorktree[WORKTREE]).toEqual(before.groupsByWorktree[WORKTREE])
    expect(after.layoutByWorktree[WORKTREE]).toBe(before.layoutByWorktree[WORKTREE])
    expect(after.activeGroupIdByWorktree[WORKTREE]).toBe(DRAFT_GROUP)
    expect(after.activeTabId).toBe(DRAFT_TAB)
    expect(after.activeTabIdByWorktree[WORKTREE]).toBe(DRAFT_TAB)
    expect(after.unifiedTabsByWorktree[WORKTREE]).toHaveLength(2)
    expect(after.unifiedTabsByWorktree[WORKTREE].find((tab) => tab.id === DRAFT_TAB)).toMatchObject(
      {
        entityId: DRAFT_TAB,
        groupId: DRAFT_GROUP,
        viewMode: 'chat'
      }
    )
    expect(after.pendingStartupByTabId[DRAFT_TAB]).toEqual({
      command: 'codex',
      draftPrompt: 'Review the changes'
    })
    expect(after.terminalLayoutsByTabId[DRAFT_TAB].root).not.toBeNull()
    expect(after.ptyIdsByTabId[LIVE_TAB]).toEqual(['live-pty'])
    expect(startTerminalTabProviderRetirement).not.toHaveBeenCalled()
  })

  it.each([WORKTREE, OTHER_WORKTREE])(
    'refuses to replace a live tab when launching in %s',
    (worktreeId) => {
      const store = createReservedSplitStore()
      const before = store.getState()

      expect(() =>
        store.getState().createTab(worktreeId, undefined, undefined, {
          id: LIVE_TAB,
          replaceConversationDraft: true,
          pendingStartup: { command: 'codex' }
        })
      ).toThrow('The conversation draft is no longer available for launch.')

      expect(store.getState()).toBe(before)
      expect(store.getState().ptyIdsByTabId[LIVE_TAB]).toEqual(['live-pty'])
      expect(startTerminalTabProviderRetirement).not.toHaveBeenCalled()
    }
  )

  it.each(['row PTY', 'pane PTY', 'pending startup'] as const)(
    'refuses to overwrite a draft that acquired a %s',
    (ownership) => {
      const store = createReservedSplitStore()
      if (ownership === 'row PTY') {
        store.setState((state) => ({
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [WORKTREE]: state.tabsByWorktree[WORKTREE].map((tab) =>
              tab.id === DRAFT_TAB ? { ...tab, ptyId: 'claimed-pty' } : tab
            )
          }
        }))
      } else if (ownership === 'pane PTY') {
        store.setState((state) => ({
          ptyIdsByTabId: { ...state.ptyIdsByTabId, [DRAFT_TAB]: ['claimed-pty'] }
        }))
      } else {
        store.setState({ pendingStartupByTabId: { [DRAFT_TAB]: { command: 'existing-agent' } } })
      }
      const before = store.getState()

      expect(() =>
        store.getState().createTab(WORKTREE, DRAFT_GROUP, undefined, {
          id: DRAFT_TAB,
          replaceConversationDraft: true,
          pendingStartup: { command: 'codex' }
        })
      ).toThrow('The conversation draft is no longer available for launch.')

      expect(store.getState()).toBe(before)
    }
  )

  it('closes an unlaunched draft without provider teardown or a reopenable shell', () => {
    const store = createReservedSplitStore()

    store.getState().closeTab(DRAFT_TAB)

    const closed = store.getState()
    expect(closed.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([LIVE_TAB])
    expect(closed.unifiedTabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([LIVE_TAB])
    expect(closed.terminalLayoutsByTabId[DRAFT_TAB]).toBeUndefined()
    expect(closed.ptyIdsByTabId[DRAFT_TAB]).toBeUndefined()
    expect(closed.recentlyClosedTerminalTabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(closed.recentlyClosedTabKindsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(closed.reopenClosedTerminalTab(WORKTREE)).toBe(false)
    expect(closed.reopenClosedTab(WORKTREE)).toBe(false)
    expect(store.getState().tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([LIVE_TAB])
    expect(startTerminalTabProviderRetirement).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalled()
  })
})
