import { conversationViewKey } from './conversation-view'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import { rowNeedsPerson } from './session-sidebar-tree-order'

/**
 * Focus inside a group: the conversation in use rises to the top of the group it is listed in,
 * and once the group has sat idle the rest fold under a "Show all N" control. Opening a group
 * always lists everything; the fold only comes after the idle wait (the same one groups fold on).
 */

/** Groups a person opens on purpose to look through, so their rows never fold under focus. */
const NEVER_FOCUSED = new Set<SessionSidebarGroup['kind']>(['attention', 'archived', 'hidden'])

type FocusableGroup = Pick<SessionSidebarGroup, 'key' | 'kind' | 'rows' | 'collapsed'> & {
  focusRows?: SessionSidebarTreeRow[]
  fleetRows?: readonly unknown[]
  routineRows?: readonly unknown[]
}

function rowHolds(row: SessionSidebarTreeRow, key: string): boolean {
  return (
    conversationViewKey(row.session) === key ||
    (row.children?.some((child) => rowHolds(child, key)) ?? false)
  )
}

/** The group's top-level rows holding a key in `keys`, in the order of `keys` (the focused first). */
function heldRows(
  rows: readonly SessionSidebarTreeRow[],
  keys: readonly string[]
): SessionSidebarTreeRow[] {
  const held: SessionSidebarTreeRow[] = []
  for (const key of keys) {
    const row = rows.find((candidate) => rowHolds(candidate, key))
    if (row && !held.includes(row)) {
      held.push(row)
    }
  }
  return held
}

function extraCount(group: FocusableGroup): number {
  return (group.fleetRows?.length ?? 0) + (group.routineRows?.length ?? 0)
}

/** Whether focus could fold anything away in this open group: rows beyond the ones in use. */
function focusable(group: FocusableGroup, held: readonly SessionSidebarTreeRow[]): boolean {
  return (
    !group.collapsed &&
    !NEVER_FOCUSED.has(group.kind) &&
    held.length > 0 &&
    group.rows.length + extraCount(group) > held.length
  )
}

/**
 * Raise the rows in use (`keys`, focused first) to the top of each open group listing them, and
 * in a `trimmed` group list only those plus anything that needs the person. Groups without a
 * row in use come back untouched, so the list's memoized groups stay stable.
 */
export function focusSessionSidebarGroups<G extends FocusableGroup>(
  groups: readonly G[],
  keys: readonly string[],
  trimmed: ReadonlySet<string>
): G[] {
  if (keys.length === 0) {
    return groups as G[]
  }
  return groups.map((group) => {
    const held = heldRows(group.rows, keys)
    if (!focusable(group, held)) {
      return group
    }
    const rest = group.rows.filter((row) => !held.includes(row))
    const rows = [...held, ...rest]
    if (!trimmed.has(group.key)) {
      return rows.every((row, index) => row === group.rows[index]) ? group : { ...group, rows }
    }
    // Why: a question never hides behind focus, just as folding a folder never hides one.
    return { ...group, rows, focusRows: [...held, ...rest.filter(rowNeedsPerson)] }
  })
}

/**
 * One tick of the focus fold: which open groups holding a row in use have sat idle for
 * `seconds` and should now list only that row. `idleSince` is updated in place — a protected
 * (hovered, dragged over) group restarts its clock, and a group that stops qualifying forgets it.
 */
export function groupsToFocus(args: {
  groups: readonly FocusableGroup[]
  keys: readonly string[]
  trimmed: ReadonlySet<string>
  protectedKeys: ReadonlySet<string>
  idleSince: Map<string, number>
  now: number
  seconds: number
}): string[] {
  const { groups, keys, trimmed, protectedKeys, idleSince, now, seconds } = args
  const waiting = new Set<string>()
  const due: string[] = []
  if (seconds > 0) {
    for (const group of groups) {
      if (trimmed.has(group.key) || !focusable(group, heldRows(group.rows, keys))) {
        continue
      }
      waiting.add(group.key)
      if (protectedKeys.has(group.key) || !idleSince.has(group.key)) {
        idleSince.set(group.key, now)
      } else if (now - idleSince.get(group.key)! >= seconds * 1000) {
        due.push(group.key)
      }
    }
  }
  for (const key of idleSince.keys()) {
    if (!waiting.has(key) || due.includes(key)) {
      idleSince.delete(key)
    }
  }
  return due
}
