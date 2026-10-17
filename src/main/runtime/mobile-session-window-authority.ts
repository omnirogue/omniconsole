// Step 3 producer fix (session-count fix, C2): while a desktop window is the inventory authority,
// its current accepted publication decides the surfaces it lists. Runtime reconcilers (headless
// browser reconcile, headless hydration, listAll repair, live-terminal restore) may add or remove
// only runtime-owned surfaces and must never remove one the window publishes.
//
// Live capture (Mac Studio, 5 Oct 2026): the browser reconcile replaced every browser row with the
// runtime's own registry, which never lists the window's <webview> pages, so three of the window's
// browser tabs were dropped and re-added by the next renderer sync, five times in eight minutes.

import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

const HEADLESS_MERGE_EPOCH_MARKER = ':headless-merge:'

export type AcceptedWindowPublication = {
  publicationEpoch: string
  rendererTabIdentityKeys: ReadonlySet<string>
}

/**
 * The window publication a stored snapshot derives from, while that window is the inventory
 * authority. Null under headless authority, once the window closed (no authoritative window), for
 * a publication from a renderer generation other than the current window's, and for a snapshot
 * some other writer built (a headless rebuild, a PTY rescue) — reconcilers then keep today's rules.
 */
export function resolveWindowPublicationAuthority(args: {
  authoritativeWindowId: number | null
  headlessWindowId: number
  /** The current window's renderer generation; its publications carry it as their epoch. */
  rendererGeneration: string | null | undefined
  accepted: AcceptedWindowPublication | undefined
  snapshot: RuntimeMobileSessionTabsSnapshot
}): AcceptedWindowPublication | null {
  if (
    args.authoritativeWindowId === null ||
    args.authoritativeWindowId === args.headlessWindowId ||
    !args.accepted ||
    !args.rendererGeneration ||
    args.accepted.publicationEpoch !== args.rendererGeneration
  ) {
    return null
  }
  const base = args.snapshot.publicationEpoch.split(HEADLESS_MERGE_EPOCH_MARKER)[0]
  return base === args.accepted.publicationEpoch ? args.accepted : null
}

export function isWindowPublishedSurface(
  authority: AcceptedWindowPublication | null,
  identityKeys: readonly string[]
): boolean {
  return (
    authority !== null && identityKeys.some((key) => authority.rendererTabIdentityKeys.has(key))
  )
}

export type HeadlessBrowserTabReconcilePlan = {
  tabs: RuntimeMobileSessionSnapshotTab[]
  /** Window-published browser rows the runtime registry does not list; kept, never dropped. */
  keptWindowTabIds: string[]
  /** Runtime-owned browser rows no longer live. */
  droppedRuntimeTabIds: string[]
}

/** Replaces only runtime-owned browser rows with the live runtime set; window rows stay put. */
export function planHeadlessBrowserTabReconcile(args: {
  existingTabs: readonly RuntimeMobileSessionSnapshotTab[]
  liveBrowserTabs: readonly RuntimeMobileSessionBrowserTab[]
  authority: AcceptedWindowPublication | null
  identityKeys: (tab: RuntimeMobileSessionSnapshotTab) => string[]
}): HeadlessBrowserTabReconcilePlan {
  const liveIds = new Set(args.liveBrowserTabs.map((tab) => tab.id))
  const kept = new Set<RuntimeMobileSessionSnapshotTab>()
  const droppedRuntimeTabIds: string[] = []
  for (const tab of args.existingTabs) {
    if (tab.type !== 'browser' || liveIds.has(tab.id)) {
      continue
    }
    if (isWindowPublishedSurface(args.authority, args.identityKeys(tab))) {
      kept.add(tab)
    } else {
      droppedRuntimeTabIds.push(tab.id)
    }
  }
  return {
    // Why this order: with nothing kept it is exactly the previous reconcile's output.
    tabs: [
      ...args.existingTabs.filter((tab) => tab.type !== 'browser' || kept.has(tab)),
      ...args.liveBrowserTabs
    ],
    keptWindowTabIds: [...kept].map((tab) => tab.id),
    droppedRuntimeTabIds
  }
}
