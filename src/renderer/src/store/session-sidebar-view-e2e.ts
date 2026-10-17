import type { SessionSidebarLayout } from '@/lib/session-sidebar-view'

export type SessionSidebarViewE2E = {
  /** Loads the per-device sidebar view if needed, then saves this layout to it. */
  setLayout: (layout: SessionSidebarLayout) => Promise<void>
}

/**
 * E2E-only handle on the sidebar view store. Why: the sidebar opens in the five-line focus view,
 * so specs about the full tree pin it; the store is per profile and not on `window.__store`.
 */
export function installSessionSidebarViewE2E(target: Record<string, unknown>): void {
  const handle: SessionSidebarViewE2E = {
    setLayout: async (layout) => {
      // Why dynamic: the view store reaches back into the app store, so a static import would cycle.
      const { useSessionSidebarView } = await import('./session-sidebar-view')
      if (!useSessionSidebarView.getState().loaded) {
        useSessionSidebarView.getState().load()
      }
      useSessionSidebarView.getState().setLayout(layout)
    }
  }
  target.__sessionSidebarViewE2E = handle
}
