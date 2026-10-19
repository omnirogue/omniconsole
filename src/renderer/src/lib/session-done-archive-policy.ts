import { sessionOrganizationScope } from './account-sync/session-organization-intent'
import type { AppState } from '@/store'
import { DONE_ARCHIVE_DEFAULT_MINUTES } from '../../../shared/session-done-archive'
import type { SessionFolderMetadata } from './session-folders'
import { isSessionSaved } from './session-folders'
import { isAgentLaunchedSession } from './agent-session-note'
import type { SessionSidebarView } from './session-sidebar-view'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'
import { conversationViewKey } from './conversation-view'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from './foreground-terminal-tabs'
import { selectOnScreenSessionTabId } from './sidebar-session-on-screen'

/** Uses the same Done and bell projection as the sidebar, never the absence of a process. */
export function sessionDoneArchiveRevision(
  row: PursuitSidebarTreeRow,
  state: AppState,
  metadata: SessionFolderMetadata,
  view: SessionSidebarView,
  unique: boolean
): string | null {
  const { session } = row
  const key = conversationViewKey(session)
  const finish = metadata.finishActions?.[key]
  const status = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : null
  if (
    // A finished answer does not make a conversation disposable: only When finished: End
    // (`--ephemeral`) or an agent's launch does (Sal, 2026-10-19: "human started sessions stay
    // open until we close them").
    ((finish?.action !== 'end' || finish.afterCompletion !== true) &&
      !isAgentLaunchedSession(metadata, key)) ||
    !unique ||
    state.workspaceSessionReady !== true ||
    !session.sessionKey ||
    !session.tabId ||
    session.unavailable ||
    session.launchPending ||
    row.archived ||
    !row.completed ||
    row.pursuitState !== 'done' ||
    row.attention ||
    row.planNeedsYou ||
    (row.unreadCompletion && sessionTabLastSeenAt(session.tabId) !== null) ||
    row.activityUnverifiable ||
    row.waitingUntil ||
    row.backgroundTaskCount ||
    status?.workingMode ||
    status?.failed ||
    status?.interrupted ||
    state.pendingStartupByTabId?.[session.tabId] ||
    view.deleted?.includes(key) ||
    view.autoArchiveKeep?.includes(key) ||
    isSessionSaved(metadata, key)
  ) {
    return null
  }
  return JSON.stringify([
    sessionOrganizationScope(),
    session.rowKey,
    session.sessionKey,
    session.worktreeId,
    session.hostId,
    status?.updatedAt ?? row.completed.at,
    row.pursuitChain?.updatedAt ?? null
  ])
}

/** Its tab is in front now: the active tab, a visible split or group, or a portal. */
export function isSessionTabOnScreen(state: AppState, tabId: string): boolean {
  return (
    getForegroundTerminalTabIds().includes(tabId) || selectOnScreenSessionTabId(state) === tabId
  )
}

/** When its tab was last in front in this window run; null when never seen. */
export function sessionTabLastSeenAt(tabId: string | null): number | null {
  return tabId ? (getForegroundTerminalTabLastSeenAtById()[tabId] ?? null) : null
}

/**
 * The empty-session rule's owner revision: the row is unprompted, idle, off screen and holds
 * nothing, and the value changes with every status update, keystroke into the pane and look at
 * it, so a prompt or a glance that lands after main's judgment is seen. A start-only "done"
 * status (Claude's SessionStart) is still empty: emptiness is main's reading, never Done here.
 */
export function sessionEmptyArchiveRevision(
  row: PursuitSidebarTreeRow,
  state: AppState,
  metadata: SessionFolderMetadata,
  view: SessionSidebarView,
  unique: boolean
): string | null {
  const { session } = row
  const key = conversationViewKey(session)
  const status = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : null
  if (
    // Why: a blank session a person opened is theirs to close; only an agent's is cleaned up.
    !isAgentLaunchedSession(metadata, key) ||
    !unique ||
    state.workspaceSessionReady !== true ||
    !session.sessionKey ||
    !session.tabId ||
    session.unavailable ||
    session.launchPending ||
    row.archived ||
    row.attention ||
    row.planNeedsYou ||
    row.unreadCompletion ||
    row.activityUnverifiable ||
    row.waitingUntil ||
    row.backgroundTaskCount ||
    status?.prompt ||
    status?.state === 'working' ||
    status?.state === 'blocked' ||
    status?.workingMode ||
    status?.failed ||
    status?.interrupted ||
    state.pendingStartupByTabId?.[session.tabId] ||
    state.nativeChatLaunchDraftByTabId?.[session.tabId] ||
    isSessionTabOnScreen(state, session.tabId) ||
    view.deleted?.includes(key) ||
    view.autoArchiveKeep?.includes(key) ||
    isSessionSaved(metadata, key)
  ) {
    return null
  }
  return JSON.stringify([
    sessionOrganizationScope(),
    session.rowKey,
    session.sessionKey,
    session.worktreeId,
    session.hostId,
    status?.state ?? null,
    status?.updatedAt ?? null,
    session.paneKey ? (state.lastTerminalInputAtByPaneKey?.[session.paneKey] ?? null) : null,
    row.completed?.at ?? null,
    sessionTabLastSeenAt(session.tabId)
  ])
}

export function sessionDoneArchivePolicy(
  view: SessionSidebarView,
  key: string,
  revision: string | null
) {
  const minutes = view.doneArchiveMinutes ?? DONE_ARCHIVE_DEFAULT_MINUTES
  const clock = view.doneArchiveClocks?.[key]
  return minutes > 0 && revision && clock?.revision === revision
    ? { ...clock, delayMs: minutes * 60_000 }
    : null
}
