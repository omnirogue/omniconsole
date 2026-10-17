import type { SidebarSession } from './sidebar-sessions'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-tree'

// Why: status pings and the minute tick rebuild these lists; an unchanged row must keep its
// identity so a memoized row skips the render.

function shallowEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
  )
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  compare: (key: string, a: unknown, b: unknown) => boolean
): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) {
    return false
  }
  return keys.every((key) => Object.hasOwn(right, key) && compare(key, left[key], right[key]))
}

export function sameSidebarSession(left: SidebarSession, right: SidebarSession): boolean {
  return sameRecord(left, right, (_key, a, b) => shallowEqual(a, b))
}

/** `next` with every value-equal session swapped for its previous object; `previous` itself when nothing changed. */
export function shareSidebarSessions(
  previous: SidebarSession[],
  next: SidebarSession[]
): SidebarSession[] {
  if (previous.length === 0) {
    return next
  }
  const byRowKey = new Map(previous.map((session) => [session.rowKey, session] as const))
  let changed = previous.length !== next.length
  const shared = next.map((session, index) => {
    const prior = byRowKey.get(session.rowKey)
    const kept = prior && sameSidebarSession(prior, session) ? prior : session
    if (kept !== previous[index]) {
      changed = true
    }
    return kept
  })
  return changed ? shared : previous
}

export function sameSessionSidebarTreeRow(
  left: SessionSidebarTreeRow,
  right: SessionSidebarTreeRow
): boolean {
  return sameRecord(left, right, (key, a, b) =>
    key === 'session' ? Object.is(a, b) : shallowEqual(a, b)
  )
}

function sameRows(
  left: readonly SessionSidebarTreeRow[],
  right: readonly SessionSidebarTreeRow[]
): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index])
}

function sameGroup(left: SessionSidebarGroup, right: SessionSidebarGroup): boolean {
  return sameRecord(left, right, (key, a, b) =>
    key === 'rows'
      ? sameRows(a as SessionSidebarTreeRow[], b as SessionSidebarTreeRow[])
      : shallowEqual(a, b)
  )
}

/**
 * Carry row and group identity across tree rebuilds. Rows are matched by row key (a row
 * listed under Needs you and its folder is one object in both), groups by group key.
 */
export function shareSessionSidebarGroups<T extends SessionSidebarGroup>(
  previous: readonly T[],
  next: readonly T[]
): readonly T[] {
  if (previous.length === 0) {
    return next
  }
  const priorRows = new Map<string, SessionSidebarTreeRow>()
  for (const group of previous) {
    for (const row of group.rows) {
      priorRows.set(row.session.rowKey, row)
    }
  }
  const priorGroups = new Map(previous.map((group) => [group.key, group] as const))
  const nextRows = new Map<SessionSidebarTreeRow, SessionSidebarTreeRow>()
  const shareRow = (row: SessionSidebarTreeRow): SessionSidebarTreeRow => {
    let kept = nextRows.get(row)
    if (!kept) {
      const prior = priorRows.get(row.session.rowKey)
      kept = prior && sameSessionSidebarTreeRow(prior, row) ? prior : row
      nextRows.set(row, kept)
    }
    return kept
  }
  let changed = previous.length !== next.length
  const shared = next.map((group, index) => {
    const rows = group.rows.map(shareRow)
    const candidate = sameRows(rows, group.rows) ? group : { ...group, rows }
    const prior = priorGroups.get(group.key)
    const kept = prior && sameGroup(prior, candidate) ? prior : candidate
    if (kept !== previous[index]) {
      changed = true
    }
    return kept
  })
  return changed ? shared : previous
}
