import { conversationViewKey } from '@/lib/conversation-view'
import {
  conversationFleetRowKey,
  type ConversationFleetSidebarRow
} from '@/lib/conversation-fleet-sidebar'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionGroupListedRows, type SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'

/**
 * Multi-selection over the Conversations list, keyed by `conversationViewKey`.
 *
 * `anchor` is the row a range grows from and `focus` the row it grows to; keeping them
 * apart is what lets Shift+Up after Shift+Down shrink the range back toward the anchor
 * instead of growing it the other way. A range always replaces the selection, like the
 * worktree list, so the outcome after any mix of toggles is the visible span anchor→focus.
 */
export type SessionSelectionIntent = 'replace' | 'toggle' | 'range'

export type SessionSelection = {
  selected: ReadonlySet<string>
  anchor: string | null
  focus: string | null
}

const EMPTY: SessionSelection = { selected: new Set(), anchor: null, focus: null }

export function emptySessionSelection(): SessionSelection {
  return EMPTY
}

export function sessionSelectionIntent(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): SessionSelectionIntent {
  if (event.shiftKey) {
    return 'range'
  }
  const toggle = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return toggle ? 'toggle' : 'replace'
}

function span(visibleKeys: readonly string[], from: string, to: string): Set<string> {
  const start = visibleKeys.indexOf(from)
  const end = visibleKeys.indexOf(to)
  if (start === -1 || end === -1) {
    return new Set([to])
  }
  return new Set(visibleKeys.slice(Math.min(start, end), Math.max(start, end) + 1))
}

export function updateSessionSelection(params: {
  visibleKeys: readonly string[]
  previous: SessionSelection
  targetKey: string
  intent: SessionSelectionIntent
}): SessionSelection {
  const { visibleKeys, previous, targetKey, intent } = params
  if (intent === 'replace') {
    return { selected: new Set([targetKey]), anchor: targetKey, focus: targetKey }
  }
  if (intent === 'toggle') {
    const selected = new Set(previous.selected)
    if (selected.has(targetKey)) {
      selected.delete(targetKey)
    } else {
      selected.add(targetKey)
    }
    return { selected, anchor: targetKey, focus: targetKey }
  }
  const anchor = previous.anchor && visibleKeys.includes(previous.anchor) ? previous.anchor : null
  if (!anchor) {
    return { selected: new Set([targetKey]), anchor: targetKey, focus: targetKey }
  }
  return { selected: span(visibleKeys, anchor, targetKey), anchor, focus: targetKey }
}

/** Shift+Down / Shift+Up: move the focus end one visible row and reselect anchor→focus. */
export function extendSessionSelection(params: {
  visibleKeys: readonly string[]
  previous: SessionSelection
  direction: 'up' | 'down'
}): SessionSelection {
  const { visibleKeys, previous, direction } = params
  if (visibleKeys.length === 0) {
    return previous
  }
  const step = direction === 'down' ? 1 : -1
  const anchor = previous.anchor && visibleKeys.includes(previous.anchor) ? previous.anchor : null
  if (!anchor) {
    // Why: with nothing anchored the gesture starts a selection at the edge it moves from.
    const key = direction === 'down' ? visibleKeys[0]! : visibleKeys.at(-1)!
    return { selected: new Set([key]), anchor: key, focus: key }
  }
  const focus = previous.focus && visibleKeys.includes(previous.focus) ? previous.focus : anchor
  const index = visibleKeys.indexOf(focus) + step
  if (index < 0 || index >= visibleKeys.length) {
    return { selected: span(visibleKeys, anchor, focus), anchor, focus }
  }
  const next = visibleKeys[index]!
  return { selected: span(visibleKeys, anchor, next), anchor, focus: next }
}

/** Plain Down / Up: move focus one visible row and select just that row. */
export function stepSessionSelection(params: {
  visibleKeys: readonly string[]
  previous: SessionSelection
  direction: 'up' | 'down'
}): SessionSelection {
  const { visibleKeys, previous, direction } = params
  if (visibleKeys.length === 0) {
    return previous
  }
  const focus = previous.focus && visibleKeys.includes(previous.focus) ? previous.focus : null
  const index = focus
    ? Math.min(
        visibleKeys.length - 1,
        Math.max(0, visibleKeys.indexOf(focus) + (direction === 'down' ? 1 : -1))
      )
    : direction === 'down'
      ? 0
      : visibleKeys.length - 1
  const key = visibleKeys[index]!
  return { selected: new Set([key]), anchor: key, focus: key }
}

export function selectAllSessions(visibleKeys: readonly string[]): SessionSelection {
  if (visibleKeys.length === 0) {
    return EMPTY
  }
  return { selected: new Set(visibleKeys), anchor: visibleKeys[0]!, focus: visibleKeys.at(-1)! }
}

/** Drop keys no longer on screen so a filter never leaves an unseen row selected. */
export function pruneSessionSelection(
  previous: SessionSelection,
  visibleKeys: readonly string[]
): SessionSelection {
  const visible = new Set(visibleKeys)
  const selected = new Set<string>()
  for (const key of previous.selected) {
    if (visible.has(key)) {
      selected.add(key)
    }
  }
  if (
    selected.size === previous.selected.size &&
    (previous.anchor === null || visible.has(previous.anchor)) &&
    (previous.focus === null || visible.has(previous.focus))
  ) {
    return previous
  }
  const first = selected.values().next().value ?? null
  return {
    selected,
    anchor: previous.anchor && visible.has(previous.anchor) ? previous.anchor : first,
    focus: previous.focus && visible.has(previous.focus) ? previous.focus : first
  }
}

export function sameSessionSelection(a: SessionSelection, b: SessionSelection): boolean {
  if (a.anchor !== b.anchor || a.focus !== b.focus || a.selected.size !== b.selected.size) {
    return false
  }
  for (const key of a.selected) {
    if (!b.selected.has(key)) {
      return false
    }
  }
  return true
}

/** What is on screen in display order (open groups, and a folded one's peek rows), each once. */
export function visibleSessionSelection(
  groups: readonly (SessionSidebarGroup & {
    fleetRows?: readonly ConversationFleetSidebarRow[]
    routineRows?: readonly ConversationRoutineRow[]
  })[]
): {
  order: string[]
  byKey: Map<string, SidebarSession>
  /** Conversations on other computers (fleet receipts), by the key their row is filed under. */
  fleetByKey: Map<string, ConversationFleetSidebarRow>
  /** Routines listed among the conversations, by their `routine:…` key. */
  routinesByKey: Map<string, ConversationRoutineRow>
} {
  const order: string[] = []
  const byKey = new Map<string, SidebarSession>()
  const fleetByKey = new Map<string, ConversationFleetSidebarRow>()
  const routinesByKey = new Map<string, ConversationRoutineRow>()
  for (const group of groups) {
    // Why: a folded folder still lists what needs the person, and those rows are on screen.
    for (const row of sessionGroupListedRows(group)) {
      const key = conversationViewKey(row.session)
      if (!byKey.has(key)) {
        byKey.set(key, row.session)
        order.push(key)
      }
    }
    // Why focus too: its receipts and routines wait behind Show all with the rest of the group.
    if (group.collapsed || group.focusRows) {
      continue
    }
    // Why: a receipt from another computer is drawn after the group's sessions and selects like
    // one of them, so Select All, Shift-ranges and the bulk bar reach every computer's work.
    for (const fleet of group.fleetRows ?? []) {
      const key = conversationFleetRowKey(fleet.run, fleet.source)
      if (!byKey.has(key) && !fleetByKey.has(key)) {
        fleetByKey.set(key, fleet)
        order.push(key)
      }
    }
    // Why: a routine row is drawn after the group's receipts, so it is selected in that order too.
    for (const routine of group.routineRows ?? []) {
      if (!routinesByKey.has(routine.key)) {
        routinesByKey.set(routine.key, routine)
        order.push(routine.key)
      }
    }
  }
  return { order, byKey, fleetByKey, routinesByKey }
}
