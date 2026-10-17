import { isCommandCenterView } from '../../../shared/command-center-navigation'
import type { AppState } from '@/store'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import type { SidebarSession } from './sidebar-sessions'

/**
 * What the main screen shows, in the identity sidebar rows carry (see buildSidebarSessions):
 * a terminal row's `tabId` is the terminal tab id (the unified tab's `entityId`), a structured
 * row's `tabId` is the unified agent-session tab id.
 *
 * Why not the store's `activeTabId`: it only tracks terminal tabs and falls back to the last
 * terminal while an agent-session, editor or browser tab is in front, so a stale row stayed lit.
 */
export type OnScreenSessionSource = Partial<
  Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'activeTabId'
    | 'activeTabType'
    | 'groupsByWorktree'
    | 'activeGroupIdByWorktree'
    | 'unifiedTabsByWorktree'
    | 'terminalLayoutsByTabId'
  >
>

type OnScreenTab = { tabId: string; terminal: boolean }

function onScreenTab(state: OnScreenSessionSource): OnScreenTab | null {
  const worktreeId = state.activeWorktreeId
  // Grid and Attention report borrowed terminals through the portal targets.
  if (state.activeView && isCommandCenterView(state.activeView)) {
    return null
  }
  if (state.activeView !== 'terminal' || !worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree?.[worktreeId]
  if (!groups || groups.length === 0) {
    // Why: a workspace that never grew a tab group only ever shows its terminal surface.
    return state.activeTabType === 'terminal' && state.activeTabId
      ? { tabId: state.activeTabId, terminal: true }
      : null
  }
  const activeGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  const group = groups.find((candidate) => candidate.id === activeGroupId) ?? groups[0]
  if (!group?.activeTabId) {
    return null
  }
  const tab = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (candidate) => candidate.id === group.activeTabId && candidate.groupId === group.id
  )
  if (tab?.contentType === 'terminal') {
    return { tabId: tab.entityId, terminal: true }
  }
  if (tab?.contentType === 'agent-session') {
    return { tabId: tab.id, terminal: false }
  }
  // Editors, browsers and the rest are not conversations: no row is on screen.
  return null
}

/** The on-screen tab in sidebar-row identity, or null when no conversation tab is in front. */
export function selectOnScreenSessionTabId(state: OnScreenSessionSource): string | null {
  return onScreenTab(state)?.tabId ?? null
}

/** Keep the visible leaf identity even after a split collapses. */
export function selectOnScreenSessionLeafId(state: OnScreenSessionSource): string | null {
  const tab = onScreenTab(state)
  if (!tab?.terminal) {
    return null
  }
  const layout = state.terminalLayoutsByTabId?.[tab.tabId]
  const activeLeafId = layout?.activeLeafId ?? null
  if (!activeLeafId) {
    return null
  }
  const leaves = collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId)
  return leaves.includes(activeLeafId as (typeof leaves)[number])
    ? activeLeafId
    : leaves.length === 1
      ? leaves[0]
      : null
}

export type OnScreenSession = {
  worktreeId: string | null
  tabId: string | null
  /** Set only for a split terminal tab; see selectOnScreenSessionLeafId. */
  leafId?: string | null
}

export function isSidebarSessionOnScreen(
  session: Pick<SidebarSession, 'tabId' | 'paneKey' | 'worktreeId'>,
  screen: OnScreenSession
): boolean {
  if (session.tabId === null || session.tabId !== screen.tabId) {
    return false
  }
  if (session.worktreeId !== screen.worktreeId) {
    return false
  }
  if (!screen.leafId || !session.paneKey) {
    return true
  }
  return parsePaneKey(session.paneKey)?.leafId === screen.leafId
}
