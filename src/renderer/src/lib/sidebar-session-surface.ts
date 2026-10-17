import { e2eConfig } from './e2e-config'

/** Which tree the sidebar shows under the navigation. */
export type SidebarSessionSurface = 'sessions' | 'technical' | 'goals' | 'workspaces' | 'team'

/**
 * Older builds persisted the sidebar surface as `'companies'` (Companies has
 * since become a primary destination of its own, above this strip, so it was
 * dropped here). Anything unrecognised — a stale `'companies'`, a future
 * value this build predates, corrupt JSON — lands on `'sessions'`
 * (Conversations), the human default, rather than a dead surface. A saved
 * `'routines'` lands there too: routines are listed with the conversations now.
 */
export function normalizeSidebarSessionSurface(value: unknown): SidebarSessionSurface {
  return value === 'sessions' ||
    value === 'technical' ||
    value === 'goals' ||
    value === 'workspaces' ||
    value === 'team'
    ? value
    : 'sessions'
}

/**
 * Conversations is the way in for people; the e2e suite still drives the workspace
 * tree directly, so a test-launched app keeps that as its first surface.
 */
export function defaultSidebarSessionSurface(): SidebarSessionSurface {
  return e2eConfig.enabled ? 'workspaces' : 'sessions'
}
