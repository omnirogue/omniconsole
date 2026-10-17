import type { ConversationFleetSidebarRow } from '@/lib/conversation-fleet-sidebar'
import {
  sessionGroupListedRows,
  type SessionSidebarGroup,
  type SessionSidebarTreeRow
} from '@/lib/session-sidebar-tree'

/** Below this many flat rows the list renders in full: no measuring, and nothing to window. */
export const SESSION_SIDEBAR_VIRTUALIZE_AFTER = 80

export type SessionSidebarVirtualRow =
  | { kind: 'header'; key: string; groupKey: string }
  | { kind: 'row'; key: string; groupKey: string; row: SessionSidebarTreeRow }
  | {
      kind: 'extra'
      key: string
      groupKey: string
      extraIndex: number
      /** The receipt's own identity, so React state follows the workflow and not the slot. */
      extraKey: string
    }

type FlattenableGroup = Pick<
  SessionSidebarGroup,
  'key' | 'kind' | 'rows' | 'collapsed' | 'peekRows' | 'focusRows'
> & {
  fleetRows?: readonly ConversationFleetSidebarRow[]
  /** Routines listed in the group; they follow its fleet receipts as extra rows. */
  routineRows?: readonly { key: string }[]
}

/** How many extra rows a group lists after its sessions: fleet receipts, then routines. */
export function sessionGroupExtraRowCount(
  group: Pick<FlattenableGroup, 'fleetRows' | 'routineRows'>
): number {
  return (group.fleetRows?.length ?? 0) + (group.routineRows?.length ?? 0)
}

// Why: group and row keys both carry ':' and '/', so the group key's length keeps the pair
// unambiguous — with ordinary text, since a NUL separator makes this file binary to git.
function virtualRowKey(groupKey: string, suffix: string): string {
  return `${groupKey.length}:${groupKey}:${suffix}`
}

/**
 * A fleet receipt's stable identity. Keying by position hands one workflow's open details
 * dialog or pause spinner to whichever receipt admission later sorts into that slot.
 */
function fleetRowIdentity(row: ConversationFleetSidebarRow | undefined, index: number): string {
  return row?.run.workflowId || `index:${index}`
}

/** Headers and rows of every group in display order, one virtual row each. */
export function flattenSessionSidebarGroups(
  groups: readonly FlattenableGroup[],
  hideHeaders = false
): SessionSidebarVirtualRow[] {
  const rows: SessionSidebarVirtualRow[] = []
  for (const group of groups) {
    const groupKey = group.key
    if (!hideHeaders) {
      rows.push({ kind: 'header', key: virtualRowKey(groupKey, 'header'), groupKey })
    }
    for (const row of sessionGroupListedRows(group)) {
      // Why: a row listed under Needs you and its folder needs a distinct key in each.
      rows.push({ kind: 'row', key: virtualRowKey(groupKey, row.session.rowKey), groupKey, row })
    }
    // Why focus too: its receipts and routines are part of "the rest" folded under Show all.
    if (group.collapsed || group.focusRows) {
      continue
    }
    const fleetRows = group.fleetRows ?? []
    // Why: one virtual row per fleet receipt — a single slot for all of them mounts all of them.
    const taken = new Set<string>()
    for (let index = 0; index < fleetRows.length; index += 1) {
      let extraKey = fleetRowIdentity(fleetRows[index], index)
      // Why: two receipts reporting one workflow id would otherwise collide into one React key.
      while (taken.has(extraKey)) {
        extraKey = `${extraKey}:${index}`
      }
      taken.add(extraKey)
      rows.push({
        kind: 'extra',
        key: virtualRowKey(groupKey, `extra:${extraKey}`),
        groupKey,
        extraIndex: index,
        extraKey
      })
    }
    const routineRows = group.routineRows ?? []
    for (let index = 0; index < routineRows.length; index += 1) {
      const extraKey = `routine:${routineRows[index]!.key}`
      rows.push({
        kind: 'extra',
        key: virtualRowKey(groupKey, `extra:${extraKey}`),
        groupKey,
        extraIndex: fleetRows.length + index,
        extraKey
      })
    }
  }
  return rows
}

export function estimateSessionSidebarRowSize(row: SessionSidebarVirtualRow | undefined): number {
  switch (row?.kind) {
    case 'header':
      return 29
    case 'extra':
      return 53
    // Named rather than left to a default: the exhaustiveness rule counts an
    // unlisted member as unhandled, and naming them keeps a new row kind a
    // compile error here instead of silently taking a tree row's height.
    case 'row':
    case undefined:
      return 53
  }
}

/** The rendered slice of one group: which of its flat rows are in the window. */
export type SessionSidebarGroupWindow = {
  header: number | null
  rows: { index: number; row: SessionSidebarTreeRow }[]
  /** Fleet receipts in the window, by their position in the group's fleet rows. */
  extra: { index: number; extraIndex: number; extraKey: string }[]
  /** The group's final flat row, when it is in the window; it carries the gap after the group. */
  end: number | null
}

/** Split the windowed indexes into per-group slices; a group's rows are contiguous in the flat list. */
export function windowSessionSidebarGroups(
  rows: readonly SessionSidebarVirtualRow[],
  indexes: readonly number[]
): { groupKey: string; window: SessionSidebarGroupWindow }[] {
  const slices: { groupKey: string; window: SessionSidebarGroupWindow }[] = []
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const item = rows[index]
    if (!item) {
      continue
    }
    let slice = slices.at(-1)
    if (slice?.groupKey !== item.groupKey) {
      slice = {
        groupKey: item.groupKey,
        window: { header: null, rows: [], extra: [], end: null }
      }
      slices.push(slice)
    }
    if (item.kind === 'row') {
      slice.window.rows.push({ index, row: item.row })
    } else if (item.kind === 'extra') {
      slice.window.extra.push({ index, extraIndex: item.extraIndex, extraKey: item.extraKey })
    } else {
      slice.window[item.kind] = index
    }
    if (rows[index + 1]?.groupKey !== item.groupKey) {
      slice.window.end = index
    }
  }
  return slices
}
