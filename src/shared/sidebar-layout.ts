/**
 * The sidebar's per-person arrangement: what order things sit in, and what the
 * person has put away.
 *
 * Two decisions shape this file.
 *
 * A saved order is a PARTIAL list. `orderedIds` lays the saved ids first and
 * appends anything new at its default rank, so an id that disappears evaporates
 * and an id that appears lands in a sensible place — no migration, ever.
 *
 * Hiding is a preference, never a way to lose work. A row the person hid is still
 * drawn when it carries something that needs them: `reveal` overrides `hidden`.
 * Collapsed, never hidden.
 */

import { decodeSidebarGroups, type SidebarCustomGroup } from './sidebar-custom-groups'

export type DropSide = 'before' | 'after'

export type SidebarLayout = {
  /** Optional so older saved layouts retain the built-in groups. */
  groups?: SidebarCustomGroup[]
  /** Scope → the ids in that group, in the person's order. */
  orders: Record<string, string[]>
  /** Id → the label it had when it was hidden, so the restore list can name it. */
  hidden: Record<string, string>
  /**
   * Named arrangements the person saved, so one sidebar can serve a focused day and a
   * wide-open one without rebuilding either by hand.
   */
  views: SavedSidebarView[]
  /** The saved view currently applied, or null when the live layout is its own. */
  activeView: string | null
}

export type SavedSidebarView = {
  groups?: SidebarCustomGroup[]
  id: string
  name: string
  /** A full snapshot: a view restores the whole arrangement, not a patch on it. */
  orders: Record<string, string[]>
  hidden: Record<string, string>
}

export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = {
  orders: {},
  hidden: {},
  views: [],
  activeView: null
}

const MAX_VIEWS = 24
const MAX_VIEW_NAME = 80

/** Scope names the sidebar uses. A scope is one reorderable group. */
export const SIDEBAR_NAV_SCOPE = 'nav'
export const sidebarNavMemberScope = (group: string): string => `nav:${group}`
export const SIDEBAR_COMPANIES_SCOPE = 'companies'
export const sidebarCompanyDomainsScope = (company: string): string => `company:${company}/domains`

/**
 * Keys that must never reach a record, wherever the layout is built. A computed key on
 * an object literal makes an own property rather than touching the prototype, so this
 * is not the only thing standing between a hand-edited sidecar and trouble — but the
 * decode is the one place every path goes through, so the filter belongs here rather
 * than in one caller that happens to remember.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Caps, so a corrupt or grown file cannot make the sidebar the slowest thing on screen. */
const MAX_SCOPES = 200
const MAX_IDS_PER_SCOPE = 500
const MAX_HIDDEN = 1000
const MAX_KEY_LENGTH = 400
const MAX_LABEL_LENGTH = 200

function usableKey(key: string, limit = MAX_KEY_LENGTH): boolean {
  return key.length > 0 && key.length <= limit && !UNSAFE_KEYS.has(key)
}

/**
 * A total decode: any input yields a valid layout and nothing throws. A corrupt or
 * hand-edited sidecar must leave the sidebar usable, not blank.
 */
export function decodeSidebarLayout(value: unknown): SidebarLayout {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_SIDEBAR_LAYOUT
  }
  const record = value as Record<string, unknown>
  const orders: Record<string, string[]> = {}
  const rawOrders = record.orders
  if (rawOrders !== null && typeof rawOrders === 'object' && !Array.isArray(rawOrders)) {
    for (const [scope, ids] of Object.entries(rawOrders as Record<string, unknown>)) {
      if (!usableKey(scope) || !Array.isArray(ids) || Object.keys(orders).length >= MAX_SCOPES) {
        continue
      }
      const unique = [
        ...new Set(ids.filter((id): id is string => typeof id === 'string' && usableKey(id)))
      ].slice(0, MAX_IDS_PER_SCOPE)
      if (unique.length > 0) {
        orders[scope] = unique
      }
    }
  }
  const hidden: Record<string, string> = {}
  const rawHidden = record.hidden
  if (rawHidden !== null && typeof rawHidden === 'object' && !Array.isArray(rawHidden)) {
    for (const [id, label] of Object.entries(rawHidden as Record<string, unknown>)) {
      if (usableKey(id) && typeof label === 'string' && Object.keys(hidden).length < MAX_HIDDEN) {
        hidden[id] = label.slice(0, MAX_LABEL_LENGTH)
      }
    }
  }
  const views: SavedSidebarView[] = []
  const rawViews = record.views
  if (Array.isArray(rawViews)) {
    for (const entry of rawViews) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        continue
      }
      const view = entry as Record<string, unknown>
      const id = typeof view.id === 'string' ? view.id : ''
      const name = typeof view.name === 'string' ? view.name.trim() : ''
      // A view with no id or no name cannot be switched to or named, so it is not a view.
      if (!usableKey(id) || name === '' || views.length >= MAX_VIEWS) {
        continue
      }
      if (views.some((existing) => existing.id === id)) {
        continue
      }
      // Each snapshot is decoded by the same rules as the live layout.
      const inner = decodeSidebarLayout({
        orders: view.orders,
        hidden: view.hidden,
        groups: view.groups
      })
      views.push({
        id,
        name: name.slice(0, MAX_VIEW_NAME),
        orders: inner.orders,
        hidden: inner.hidden,
        ...(inner.groups ? { groups: inner.groups } : {})
      })
    }
  }
  // An active view must name one that survived, or nothing is applied.
  const rawActive = record.activeView
  const activeView =
    typeof rawActive === 'string' && views.some((view) => view.id === rawActive) ? rawActive : null
  const groups = decodeSidebarGroups(record.groups)
  return { orders, hidden, views, activeView, ...(groups.length ? { groups } : {}) }
}

/**
 * The ids of one group in the person's order. The saved order is partial, so this
 * is "saved ones that still exist, then everything else at its default rank".
 */
export function orderedIds(ids: readonly string[], saved: readonly string[] = []): string[] {
  const present = new Set(ids)
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of saved) {
    if (present.has(id) && !seen.has(id)) {
      result.push(id)
      seen.add(id)
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      result.push(id)
      seen.add(id)
    }
  }
  return result
}

/**
 * Move `id` to the chosen side of `target`, within one group. Dropping a row on
 * itself, or on an id that is not here, changes nothing.
 */
export function place(
  ids: readonly string[],
  id: string,
  target: string,
  side: DropSide
): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) {
    return [...ids]
  }
  const rest = ids.filter((candidate) => candidate !== id)
  const at = rest.indexOf(target)
  rest.splice(side === 'before' ? at : at + 1, 0, id)
  return rest
}

/**
 * Insert `id` into this group at the chosen side of `target`, for a row arriving
 * from another group. A null target appends. Any stale copy of the id is dropped
 * first so a round trip cannot leave two.
 */
export function insert(
  ids: readonly string[],
  id: string,
  target: string | null,
  side: DropSide
): string[] {
  const rest = ids.filter((candidate) => candidate !== id)
  if (target === null || !rest.includes(target)) {
    return [...rest, id]
  }
  const at = rest.indexOf(target)
  rest.splice(side === 'before' ? at : at + 1, 0, id)
  return rest
}

/**
 * Move one row one step, for the keyboard. A row already at the end does not move,
 * which is why the arrow controls disable there rather than silently doing nothing.
 */
export function moveBy(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const at = ids.indexOf(id)
  const to = at + delta
  if (at === -1 || to < 0 || to >= ids.length) {
    return [...ids]
  }
  const next = [...ids]
  next.splice(at, 1)
  next.splice(to, 0, id)
  return next
}

export function isHidden(layout: SidebarLayout, id: string): boolean {
  return Object.hasOwn(layout.hidden, id)
}

/** Rows the person put away, newest label first, for the restore list. */
export function hiddenEntries(layout: SidebarLayout): { id: string; label: string }[] {
  return Object.entries(layout.hidden)
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function withOrder(
  layout: SidebarLayout,
  scope: string,
  ids: readonly string[]
): SidebarLayout {
  // Why check here too: a scope name comes from a caller, and a layout that the decode
  // would refuse must never be written in the first place.
  if (!usableKey(scope)) {
    return layout
  }
  return {
    ...layout,
    orders: {
      ...layout.orders,
      [scope]: ids.filter((id) => usableKey(id)).slice(0, MAX_IDS_PER_SCOPE)
    }
  }
}

export function withHidden(layout: SidebarLayout, id: string, label: string): SidebarLayout {
  if (!usableKey(id)) {
    return layout
  }
  return { ...layout, hidden: { ...layout.hidden, [id]: label.slice(0, MAX_LABEL_LENGTH) } }
}

export function withoutHidden(layout: SidebarLayout, id: string): SidebarLayout {
  const hidden = { ...layout.hidden }
  delete hidden[id]
  return { ...layout, hidden }
}

/**
 * True when the LIVE arrangement is the untouched default, so Reset can say so. Saved
 * views are deliberately not counted: resetting returns the built-in order and keeps
 * every view, so a reset must stay offered to somebody who has views but no drift.
 */
export function isDefaultLayout(layout: SidebarLayout): boolean {
  return (
    Object.keys(layout.orders).length === 0 &&
    Object.keys(layout.hidden).length === 0 &&
    !layout.groups?.length
  )
}

/** Save the live arrangement under a name, or rename-in-place if the name is taken. */
export function withSavedView(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  const trimmed = name.trim().slice(0, MAX_VIEW_NAME)
  if (!usableKey(id) || trimmed === '' || layout.views.length >= MAX_VIEWS) {
    return layout
  }
  // Why case-insensitive: two views called "Focus" and "focus" are one view to a reader.
  const existing = layout.views.find((view) => view.name.toLowerCase() === trimmed.toLowerCase())
  const snapshot = {
    orders: { ...layout.orders },
    hidden: { ...layout.hidden },
    ...(layout.groups ? { groups: layout.groups.map((group) => ({ ...group })) } : {})
  }
  const view: SavedSidebarView = { id: existing?.id ?? id, name: trimmed, ...snapshot }
  return {
    ...layout,
    views: existing
      ? layout.views.map((candidate) => (candidate.id === existing.id ? view : candidate))
      : [...layout.views, view],
    activeView: view.id
  }
}

/** Apply a saved view, replacing the live arrangement with its snapshot. */
export function withAppliedView(layout: SidebarLayout, id: string): SidebarLayout {
  const view = layout.views.find((candidate) => candidate.id === id)
  if (!view) {
    return layout
  }
  const { groups: _groups, ...rest } = layout
  return {
    ...rest,
    ...(view.groups ? { groups: view.groups.map((group) => ({ ...group })) } : {}),
    orders: { ...view.orders },
    hidden: { ...view.hidden },
    activeView: view.id
  }
}

export function withoutSavedView(layout: SidebarLayout, id: string): SidebarLayout {
  if (!layout.views.some((view) => view.id === id)) {
    return layout
  }
  return {
    ...layout,
    views: layout.views.filter((view) => view.id !== id),
    activeView: layout.activeView === id ? null : layout.activeView
  }
}

/**
 * Whether the live arrangement still matches the view it says is applied. The UI marks a
 * changed view rather than silently claiming the person is looking at the saved one.
 */
export function activeViewIsDirty(layout: SidebarLayout): boolean {
  const view = layout.views.find((candidate) => candidate.id === layout.activeView)
  if (!view) {
    return false
  }
  return (
    JSON.stringify(view.orders) !== JSON.stringify(layout.orders) ||
    JSON.stringify(view.hidden) !== JSON.stringify(layout.hidden) ||
    JSON.stringify(view.groups ?? []) !== JSON.stringify(layout.groups ?? [])
  )
}
