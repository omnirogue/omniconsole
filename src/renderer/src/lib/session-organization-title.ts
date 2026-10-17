/**
 * The title an organization change reads and writes: the tab's own title (`customTitle`, or a
 * chat tab's `customLabel`), which the sidebar row shows first, with who chose its words.
 */

import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  organizationTitleOriginOf,
  type OrganizationChange,
  type OrganizationTarget,
  type OrganizationTitleOrigin
} from '../../../shared/session-organization-change'

export type OrganizationTitleRead =
  | { known: true; title: string | null; origin?: OrganizationTitleOrigin }
  | { known: false }

export type OrganizationTitleStore = {
  read: (tabId: string) => OrganizationTitleRead
  write: (
    tabId: string,
    title: string | null,
    opts: { origin: OrganizationTitleOrigin; recordInteraction: boolean }
  ) => void
}

export const appTitleStore: OrganizationTitleStore = {
  read: (tabId) => {
    const state = useAppStore.getState()
    // Why `?? {}`: a window before hydration (or a partial test store) has no tab maps yet.
    for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab) {
        return { known: true, title: tab.customTitle ?? null, origin: tab.customTitleOrigin }
      }
    }
    for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
      const tab = tabs.find((entry) => entry.id === tabId || entry.entityId === tabId)
      if (tab) {
        return { known: true, title: tab.customLabel ?? null, origin: tab.customLabelOrigin }
      }
    }
    return { known: false }
  },
  write: (tabId, title, opts) => useAppStore.getState().setTabCustomTitle(tabId, title, opts)
}

/** The tab a title target names: its tab id, else the tab of its pane key. */
export function organizationTitleTabId(target: OrganizationTarget): string | null {
  return target.tabId ?? (target.paneKey ? (parsePaneKey(target.paneKey)?.tabId ?? null) : null)
}

/** The origin a title change leaves (the shared rule the host's applier uses too). */
export function organizationTitleOrigin(change: OrganizationChange): OrganizationTitleOrigin {
  return organizationTitleOriginOf(change)
}
