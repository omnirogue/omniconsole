import { conversationState, conversationStateRank } from './conversation-state'
import { conversationViewKey } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'
import type { SessionSidebarTreeRow } from './session-sidebar-tree'
import type { SessionSidebarSort } from './session-sidebar-sort'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

/** `extra` is searchable text the row carries beyond its own fields, such as its task's title. */
export function matchesQuery(
  session: SidebarSession,
  query: string,
  extra?: string | null
): boolean {
  if (!query) {
    return true
  }
  return `${session.label} ${session.agent} ${session.workspaceLabel} ${extra ?? ''}`
    .toLowerCase()
    .includes(query)
}

/**
 * A row that is waiting on the person: an ordinary conversation's own pane asks, a plan handed it
 * back, or its run holds an open request addressed to them. A blocked, failed, idle or finished
 * run is never one; the tree clears `attention` on a plan row whose panes merely stopped.
 */
export function rowNeedsPerson(
  row: Pick<SessionSidebarTreeRow, 'attention' | 'returned' | 'planNeedsYou'>
): boolean {
  return row.attention !== null || row.returned === true || row.planNeedsYou === true
}

function rowRank(row: SessionSidebarTreeRow): number {
  return conversationStateRank(
    conversationState({
      state: row.state,
      needsYou: row.attention !== null || row.planNeedsYou === true,
      waiting: row.waitingUntil !== null
    })
  )
}

// Why: the tree is an attention router — what needs a person first, then what is
// moving, then the rest; names only break ties.
export function compareRows(left: SessionSidebarTreeRow, right: SessionSidebarTreeRow): number {
  return (
    rowRank(left) - rowRank(right) ||
    left.session.workspaceLabel.localeCompare(right.session.workspaceLabel) ||
    left.session.label.localeCompare(right.session.label) ||
    left.session.rowKey.localeCompare(right.session.rowKey)
  )
}

function statusRank(row: SessionSidebarTreeRow): number {
  return conversationStateRank(
    row.pursuitState ??
      conversationState({
        state: row.state,
        needsYou: row.attention !== null || row.planNeedsYou === true,
        waiting: row.waitingUntil !== null
      })
  )
}

/**
 * Orders rows in place by the person's sort. Status is the attention order; Manual is Status with
 * dragged rows first in their dragged order; Name and Host fall back to Status for ties.
 */
export function sortSessionSidebarRows(
  rows: SessionSidebarTreeRow[],
  args: {
    sort: SessionSidebarSort
    rowOrder?: readonly string[]
    hostLabel?: (hostId: string) => string | undefined
  }
): void {
  const byStatus = (a: SessionSidebarTreeRow, b: SessionSidebarTreeRow): number =>
    statusRank(a) - statusRank(b) || compareRows(a, b)
  if (args.sort === 'name') {
    rows.sort(
      (a, b) =>
        a.session.label.localeCompare(b.session.label, undefined, { numeric: true }) ||
        byStatus(a, b)
    )
    return
  }
  if (args.sort === 'host') {
    // Why '': this computer's sessions lead, then each host by name.
    const host = (row: SessionSidebarTreeRow): string => {
      const id = row.session.displayHostId ?? row.session.hostId ?? LOCAL_EXECUTION_HOST_ID
      return id === LOCAL_EXECUTION_HOST_ID ? '' : (args.hostLabel?.(id) ?? id)
    }
    rows.sort((a, b) => host(a).localeCompare(host(b)) || byStatus(a, b))
    return
  }
  rows.sort(byStatus)
  if (args.sort === 'manual' && args.rowOrder?.length) {
    const order = new Map(args.rowOrder.map((key, index) => [key, index]))
    const at = (row: SessionSidebarTreeRow): number =>
      order.get(conversationViewKey(row.session)) ?? Infinity
    rows.sort((a, b) => at(a) - at(b))
  }
}

/** Archived rows by when they were put away, newest first; rows with no stamp follow by finish time. */
export function newestArchivedFirst(
  rows: SessionSidebarTreeRow[],
  archivedAt: Readonly<Record<string, number>> | undefined
): SessionSidebarTreeRow[] {
  const at = (row: SessionSidebarTreeRow): number =>
    archivedAt?.[conversationViewKey(row.session)] ?? -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        at(b.row) - at(a.row) ||
        (b.row.completed?.at ?? 0) - (a.row.completed?.at ?? 0) ||
        a.index - b.index
    )
    .map(({ row }) => row)
}
