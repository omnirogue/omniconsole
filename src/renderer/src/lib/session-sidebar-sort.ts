import type { SessionSidebarView } from './session-sidebar-view'

/** How rows are ordered inside every group, in every view; saved per device as `view.sort`. */
export const SESSION_SIDEBAR_SORTS = ['status', 'name', 'host', 'manual'] as const
export type SessionSidebarSort = (typeof SESSION_SIDEBAR_SORTS)[number]

/**
 * Manual (status, then the order rows were dragged into) while a dragged order exists and no sort
 * was chosen, so a device keeps the order it has; Status otherwise.
 */
export function sessionSidebarSort(
  view: Pick<SessionSidebarView, 'sort' | 'rowOrder'>
): SessionSidebarSort {
  return view.sort ?? (view.rowOrder?.length ? 'manual' : 'status')
}

/** A sort a newer build saved reads as the default instead of failing the whole view. */
export function withKnownSessionSidebarSort(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('sort' in value)) {
    return value
  }
  const { sort, ...rest } = value as { sort?: unknown }
  return (SESSION_SIDEBAR_SORTS as readonly unknown[]).includes(sort) ? value : rest
}
