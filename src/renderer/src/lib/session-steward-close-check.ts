import { useAppStore } from '@/store'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { OrganizationRelayedChange } from '../../../shared/session-organization-change'
import {
  emptySessionEvidence,
  isStewardEmptySessionClose
} from '../../../shared/session-steward-empty-session'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { isSessionTabOnScreen } from './session-done-archive-policy'

/**
 * The window's last synchronous check before a steward close (the sidebar's Delete, which ends
 * the agent): the row main judged is still the idle, unprompted one (same revision, which also
 * turns null while it is on screen or anything is typed into it), and its tab holds no other
 * pane, since closing the tab ends every pane in it. Null for a change no steward made.
 */
export function stewardCloseRefusal(
  change: OrganizationRelayedChange | undefined,
  target: { paneKey?: string; tabId?: string }
): string | null {
  if (change?.executor.kind !== 'app' || change.executor.feature !== 'steward') {
    return null
  }
  if (!isStewardEmptySessionClose(change)) {
    return 'The steward deletes only a blank session under its own rule; nothing was closed.'
  }
  const state = useAppStore.getState()
  const row = buildSessionManageSidebarRows(state).find(
    (candidate) =>
      !candidate.folded &&
      candidate.paneKey === target.paneKey &&
      (!target.tabId || candidate.tabId === target.tabId)
  )
  const revision = row?.emptyArchiveRevision
  if (
    !row ||
    row.pinned ||
    !revision ||
    !change.evidence?.includes(emptySessionEvidence(row.viewKey, revision))
  ) {
    return 'The session is no longer blank and idle, or is on screen or held; it stays open.'
  }
  if (row.tabId && isSessionTabOnScreen(state, row.tabId)) {
    return 'The session is on screen; it stays open.'
  }
  const own = target.paneKey ? parsePaneKey(target.paneKey)?.leafId : undefined
  const leaves = row.tabId
    ? collectLeafIdsInOrder(state.terminalLayoutsByTabId?.[row.tabId]?.root).filter(
        isTerminalLeafId
      )
    : []
  if (leaves.some((leaf) => leaf !== own)) {
    return 'Its tab holds other panes, which closing it would end; it stays open.'
  }
  return null
}
