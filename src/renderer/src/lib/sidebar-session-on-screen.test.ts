import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { buildSidebarSessions, type SidebarSessionSource } from './sidebar-sessions'
import {
  isSidebarSessionOnScreen,
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId,
  type OnScreenSessionSource
} from './sidebar-session-on-screen'
import { addSessionTestTab, SESSION_TEST_LEAF } from './sidebar-session-test-fixtures'
import {
  onScreenTestWorkspace,
  SECOND_LEAF,
  unified,
  WT
} from './sidebar-session-on-screen-test-fixtures'

function currentTabIds(state: SidebarSessionSource & OnScreenSessionSource): string[] {
  const screen = {
    worktreeId: state.activeWorktreeId ?? null,
    tabId: selectOnScreenSessionTabId(state),
    leafId: selectOnScreenSessionLeafId(state)
  }
  return buildSidebarSessions(state)
    .filter((session) => isSidebarSessionOnScreen(session, screen))
    .map((session) => session.tabId ?? '')
}

describe('the conversation on the main screen', () => {
  it('is the structured agent-session tab, not the stale last terminal', () => {
    const state = onScreenTestWorkspace('chat-1')
    expect(selectOnScreenSessionTabId(state)).toBe('chat-1')
    expect(currentTabIds(state)).toEqual(['chat-1'])
  })

  it('maps a terminal tab to the terminal id its rows carry', () => {
    const state = onScreenTestWorkspace('unified-b')
    expect(selectOnScreenSessionTabId(state)).toBe('tab-b')
    expect(currentTabIds(state)).toEqual(['tab-b'])
  })

  it('follows a newly launched tab the moment the group shows it', () => {
    const state = onScreenTestWorkspace('unified-a')
    expect(currentTabIds(state)).toEqual(['tab-a'])
    const tab = addSessionTestTab(state, 'tab-new')
    tab.conversationLaunchPending = true
    state.unifiedTabsByWorktree[WT] = [
      ...state.unifiedTabsByWorktree[WT],
      unified('unified-new', 'tab-new', 'terminal')
    ]
    state.groupsByWorktree = {
      [WT]: [{ ...state.groupsByWorktree![WT][0], activeTabId: 'unified-new' }]
    }
    expect(currentTabIds(state)).toEqual(['tab-new'])
  })

  it('is nothing while an editor is in front or another page covers the workspace', () => {
    expect(selectOnScreenSessionTabId(onScreenTestWorkspace('/repo/readme.md'))).toBeNull()
    expect(
      selectOnScreenSessionTabId({ ...onScreenTestWorkspace('chat-1'), activeView: 'attention' })
    ).toBe(null)
  })

  it('uses the terminal id directly in a workspace without tab groups', () => {
    const state = { ...onScreenTestWorkspace('chat-1'), groupsByWorktree: {} }
    expect(selectOnScreenSessionTabId(state)).toBe('tab-a')
    expect(selectOnScreenSessionTabId({ ...state, activeTabType: 'browser' })).toBeNull()
  })

  it('lights only the focused pane of a split terminal tab', () => {
    const state = onScreenTestWorkspace('unified-b')
    state.terminalLayoutsByTabId['tab-b'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: SESSION_TEST_LEAF },
        second: { type: 'leaf', leafId: SECOND_LEAF }
      },
      activeLeafId: SECOND_LEAF,
      expandedLeafId: null
    }
    for (const leaf of [SESSION_TEST_LEAF, SECOND_LEAF]) {
      const paneKey = makePaneKey('tab-b', leaf)
      state.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-b',
        worktreeId: WT,
        agent: 'codex',
        providerSession: { key: 'session_id', id: `provider-${leaf}` },
        prompt: 'Work',
        terminalTitle: 'Split',
        state: 'working',
        capturedAt: 100,
        updatedAt: 100,
        origin: 'live'
      }
    }
    expect(selectOnScreenSessionLeafId(state)).toBe(SECOND_LEAF)
    const screen = { worktreeId: WT, tabId: 'tab-b', leafId: SECOND_LEAF }
    const current = buildSidebarSessions(state).filter((session) =>
      isSidebarSessionOnScreen(session, screen)
    )
    expect(current.map((session) => session.paneKey)).toEqual([makePaneKey('tab-b', SECOND_LEAF)])
    state.terminalLayoutsByTabId['tab-b'].root = { type: 'leaf', leafId: SECOND_LEAF }
    const collapsedScreen = { ...screen, leafId: selectOnScreenSessionLeafId(state) }
    expect(
      buildSidebarSessions(state)
        .filter((session) => isSidebarSessionOnScreen(session, collapsedScreen))
        .map((session) => session.paneKey)
    ).toEqual([makePaneKey('tab-b', SECOND_LEAF)])
  })

  it('keeps the visible leaf when only one pane remains', () => {
    expect(selectOnScreenSessionLeafId(onScreenTestWorkspace('unified-a'))).toBe(SESSION_TEST_LEAF)
  })
})
