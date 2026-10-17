import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

// Why: activation restores every orphaned sleeping session as a tab at once; spawning them all
// flooded the host with PTYs and bare shells (#857). A deferred tab stays unmounted until the
// user first reveals it; the revealed tab then mounts and runs its resume as before.

type DeferrableStartup = { command: string; deferUntilRevealed?: true }
type MountRestriction = ReadonlySet<string> | null
type RevealDeferralState = {
  pendingStartupByTabId: Readonly<Record<string, DeferrableStartup | undefined>>
  sleepingAgentSessionsByPaneKey: Readonly<Record<string, SleepingAgentSessionRecord>>
  tabsByWorktree: Readonly<
    Record<string, readonly { id: string; ptyId?: string | null }[] | undefined>
  >
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
}

// Why module state: a revealed tab must stay mounted until its pane spawns, even if the user
// switches away first; tab ids are globally unique UUIDs.
const revealedDeferredTabIds = new Set<string>()
const withheldRestrictionByWorktree = new Map<
  string,
  { source: MountRestriction; key: string; value: ReadonlySet<string> }
>()
const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

// Parking projections use a true marker for eager startups.
export function pendingStartupNeedsImmediateMount(startup: unknown): boolean {
  return (
    startup !== undefined &&
    !(
      typeof startup === 'object' &&
      startup !== null &&
      'deferUntilRevealed' in startup &&
      startup.deferUntilRevealed === true
    )
  )
}

type RevealDeferral = { tabIds: string[]; sleptPaneTabIds: ReadonlySet<string> }
let revealDeferralCache: (RevealDeferralState & RevealDeferral) | null = null

/** Same liveness test as recordAwaitsFirstRevealInOwnTab: a tab-level or per-tab PTY id. */
function tabHoldsLivePty(state: RevealDeferralState, worktreeId: string, tabId: string): boolean {
  if ((state.ptyIdsByTabId[tabId]?.length ?? 0) > 0) {
    return true
  }
  return Boolean(state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.ptyId)
}

/** Tabs waiting for their first reveal: a deferred queued startup (this session) or a sleeping
 *  record re-keyed onto the tab's own pane (survives restart). Sorted for shallow equality. */
export function selectRevealDeferredTabIds(state: RevealDeferralState): string[] {
  return readRevealDeferral(state).tabIds
}

/** Tabs holding a pane automatic sleep put down (tab-open-only, first reveal), held or not. */
function selectSleptPaneTabIds(state: RevealDeferralState): ReadonlySet<string> {
  return readRevealDeferral(state).sleptPaneTabIds
}

function readRevealDeferral(state: RevealDeferralState): RevealDeferral {
  const cached = revealDeferralCache
  if (
    cached?.pendingStartupByTabId === state.pendingStartupByTabId &&
    cached.sleepingAgentSessionsByPaneKey === state.sleepingAgentSessionsByPaneKey &&
    cached.tabsByWorktree === state.tabsByWorktree &&
    cached.ptyIdsByTabId === state.ptyIdsByTabId
  ) {
    return cached
  }
  const tabIds = new Set<string>()
  const sleptPaneTabIds = new Set<string>()
  for (const [tabId, startup] of Object.entries(state.pendingStartupByTabId)) {
    if (startup?.deferUntilRevealed === true) {
      tabIds.add(tabId)
    }
  }
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record.resumeOnFirstReveal !== true || !record.tabId) {
      continue
    }
    if (record.restoreOnTabOpenOnly === true) {
      sleptPaneTabIds.add(record.tabId)
    }
    // Why the PTY check: holding a tab unmounts it. That is free for a tab with no PTY (a lazy
    // restore, or one whose every pane slept), but a split whose sibling still runs would lose
    // its mounted transport, with no parked watcher, and a PTY that cannot reattach is orphaned.
    // Such a tab mounts; its slept pane waits for the tab to be opened before it connects
    // (slept-pane-connect-gate.ts), so a background mount cannot resume it.
    if (!tabHoldsLivePty(state, record.worktreeId, record.tabId)) {
      tabIds.add(record.tabId)
    }
  }
  const next = {
    pendingStartupByTabId: state.pendingStartupByTabId,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    tabIds: [...tabIds].sort(),
    sleptPaneTabIds
  }
  revealDeferralCache = next
  return next
}

export function useRevealDeferredTabIds(): ReadonlySet<string> {
  const tabIds = useAppStore(useShallow(selectRevealDeferredTabIds))
  return useMemo(() => (tabIds.length > 0 ? new Set(tabIds) : EMPTY_TAB_IDS), [tabIds])
}

export function markDeferredTabsRevealed(
  tabIds: Iterable<string>,
  deferredTabIds: ReadonlySet<string>
): void {
  // Why the slept-pane tabs: a split holding one stays mounted instead of held, and its slept pane
  // connects only once its tab is opened, so an open (or a mount targeted at the tab) is its reveal.
  const sleptPaneTabIds = selectSleptPaneTabIds(useAppStore.getState())
  const awaitsReveal = (tabId: string): boolean =>
    deferredTabIds.has(tabId) || sleptPaneTabIds.has(tabId)
  for (const tabId of revealedDeferredTabIds) {
    if (!awaitsReveal(tabId)) {
      revealedDeferredTabIds.delete(tabId)
    }
  }
  for (const tabId of tabIds) {
    if (awaitsReveal(tabId)) {
      revealedDeferredTabIds.add(tabId)
    }
  }
}

/** Whether the tab was opened, or a mount targeted it, since it began waiting for a reveal. */
export function isTabRevealed(tabId: string): boolean {
  return revealedDeferredTabIds.has(tabId)
}

export function isTabHeldUntilRevealed(
  tabId: string,
  deferredTabIds: ReadonlySet<string>
): boolean {
  return deferredTabIds.has(tabId) && !revealedDeferredTabIds.has(tabId)
}

/** Narrows a worktree's mount restriction so unrevealed deferred tabs stay unmounted.
 *  Returns the input untouched when nothing is held, and a stable Set while the result is
 *  unchanged so memoized surfaces don't re-render every pass. */
export function withholdUnrevealedDeferredTabs(
  worktreeId: string,
  restriction: MountRestriction,
  tabs: readonly { id: string }[] | undefined,
  deferredTabIds: ReadonlySet<string>
): MountRestriction {
  const held = new Set(
    (tabs ?? [])
      .filter((tab) => isTabHeldUntilRevealed(tab.id, deferredTabIds))
      .map((tab) => tab.id)
  )
  if (held.size === 0) {
    withheldRestrictionByWorktree.delete(worktreeId)
    return restriction
  }
  const allowed = (restriction ? [...restriction] : (tabs ?? []).map((tab) => tab.id)).filter(
    (tabId) => !held.has(tabId)
  )
  const key = allowed.join('\n')
  const cached = withheldRestrictionByWorktree.get(worktreeId)
  if (cached && cached.source === restriction && cached.key === key) {
    return cached.value
  }
  const value = new Set(allowed)
  withheldRestrictionByWorktree.set(worktreeId, { source: restriction, key, value })
  return value
}

export function resetDeferredStartupMountStateForTests(): void {
  revealDeferralCache = null
  revealedDeferredTabIds.clear()
  withheldRestrictionByWorktree.clear()
}
