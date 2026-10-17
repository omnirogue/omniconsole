import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const REMOTE_PAGE_ID = 'remote-page-1'

function rendererRow(): RuntimeMobileSessionBrowserTab {
  return {
    type: 'browser',
    id: 'host-unified-1',
    title: 'Plan',
    browserWorkspaceId: 'host-workspace-1',
    browserPageId: REMOTE_PAGE_ID,
    url: 'https://example.com/plan',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

/** How a headless-built owner row names the same page: by the page id alone. */
function headlessRow(): RuntimeMobileSessionBrowserTab {
  return { ...rendererRow(), id: REMOTE_PAGE_ID, browserWorkspaceId: REMOTE_PAGE_ID }
}

function frame(tabs: RuntimeMobileSessionBrowserTab[]): RuntimeMobileSessionTabsResult {
  return makeSnapshot(tabs, { activeTabId: null, activeTabType: null })
}

function applyToState(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    snapshot,
    ENV,
    NOW
  ) as Partial<WebSessionTabsSyncState>
  return { ...state, ...patch }
}

function workspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: WT,
    activePageId: REMOTE_PAGE_ID,
    pageIds: [REMOTE_PAGE_ID],
    url: 'https://example.com/plan',
    title: 'Plan',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000
  }
}

function page(workspaceId: string): BrowserPage {
  return {
    id: REMOTE_PAGE_ID,
    workspaceId,
    worktreeId: WT,
    url: 'https://example.com/plan',
    title: 'Plan',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000,
    browserRuntimeEnvironmentId: ENV
  }
}

function unifiedTab(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'host-group-1',
    worktreeId: WT,
    contentType: 'browser',
    label: 'Plan',
    customLabel: null,
    color: null,
    sortOrder: NOW - 1_000,
    createdAt: NOW - 1_000,
    isPreview: false,
    isPinned: false
  }
}

/** The shape older builds saved: two workspaces for one page, and every row stored twice. */
function doubledState(handle: Record<string, unknown>): WebSessionTabsSyncState {
  const rendererWorkspace = workspace('host-workspace-1')
  const headlessWorkspace = workspace(REMOTE_PAGE_ID)
  return makeState({
    browserTabsByWorktree: {
      [WT]: [rendererWorkspace, headlessWorkspace, rendererWorkspace, headlessWorkspace]
    },
    browserPagesByWorkspace: {
      'host-workspace-1': [page('host-workspace-1')],
      [REMOTE_PAGE_ID]: [page(REMOTE_PAGE_ID)]
    },
    remoteBrowserPageHandlesByPageId: {
      [REMOTE_PAGE_ID]:
        handle as WebSessionTabsSyncState['remoteBrowserPageHandlesByPageId'][string]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        unifiedTab('host-unified-1', 'host-workspace-1'),
        unifiedTab(REMOTE_PAGE_ID, REMOTE_PAGE_ID),
        unifiedTab('host-unified-1', 'host-workspace-1'),
        unifiedTab(REMOTE_PAGE_ID, REMOTE_PAGE_ID)
      ]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'host-group-1',
          worktreeId: WT,
          activeTabId: 'host-unified-1',
          tabOrder: ['host-unified-1', REMOTE_PAGE_ID]
        }
      ]
    }
  })
}

function browserIds(state: WebSessionTabsSyncState): {
  workspaces: string[]
  unified: string[]
} {
  return {
    workspaces: (state.browserTabsByWorktree[WT] ?? []).map((tab) => tab.id),
    unified: (state.unifiedTabsByWorktree[WT] ?? [])
      .filter((tab) => tab.contentType === 'browser')
      .map((tab) => tab.id)
  }
}

describe('one owner page published under two rows', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('mirrors the page once, frame after frame', () => {
    let state = makeState()
    for (let i = 0; i < 3; i++) {
      state = applyToState(state, frame([rendererRow(), headlessRow()]))
    }

    expect(browserIds(state)).toEqual({
      workspaces: ['host-workspace-1'],
      unified: ['host-unified-1']
    })
  })

  it.each([
    [
      'restored from disk',
      { environmentId: ENV, remotePageId: REMOTE_PAGE_ID, restoredFromSession: true }
    ],
    ['already adopted', { environmentId: ENV, remotePageId: REMOTE_PAGE_ID }]
  ])('heals saved duplicates when the handle is %s', (_label, handle) => {
    for (const tabs of [[rendererRow(), headlessRow()], [rendererRow()]]) {
      resetWebSessionTabsSyncTestState()
      const next = applyToState(doubledState(handle), frame(tabs))
      const ids = browserIds(next)

      expect(ids.workspaces).toHaveLength(1)
      expect(ids.unified).toHaveLength(1)
      const kept = next.unifiedTabsByWorktree[WT]!.find((tab) => tab.contentType === 'browser')
      expect(kept?.entityId).toBe(ids.workspaces[0])
      expect(next.browserPagesByWorkspace[ids.workspaces[0]!]?.map((p) => p.id)).toEqual([
        REMOTE_PAGE_ID
      ])
      expect(next.remoteBrowserPageHandlesByPageId[REMOTE_PAGE_ID]).toMatchObject({
        environmentId: ENV,
        remotePageId: REMOTE_PAGE_ID
      })
    }
  })
})
