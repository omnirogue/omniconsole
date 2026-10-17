import { noteTerminalTabEnteredForeground } from './launch-trigger/person-reveal-evidence'

let explicitForegroundTerminalTabIds = new Set<string>()
const visibleTerminalTabClaimsByToken = new Map<symbol, string>()
const foregroundTerminalTabLastSeenAtById = new Map<string, number>()
// Why a separate map: last-seen is also stamped when a tab LEAVES the foreground (the sleep timer
// anchors to the end of a visit), so it cannot tell "opened after it slept" from "slept while on
// screen, then left". The restore flood guard needs the moment each visit began.
const foregroundTerminalTabRevealedAtById = new Map<string, number>()

/**
 * The one place a tab's foreground visit begins (off screen -> on screen), for both readers:
 * the restore flood guard's reveal start (getForegroundTerminalTabRevealedAt) and the launch
 * trigger's person-reveal evidence (latency telemetry only, person-reveal-evidence.ts). Why one
 * source: both must agree on which visits started, or a launch the guard released for a reveal
 * could be attributed to a background mount (or the reverse).
 */
function noteRevealStarts(previous: ReadonlySet<string>, now: number): void {
  for (const tabId of getForegroundTerminalTabIds()) {
    if (!previous.has(tabId)) {
      foregroundTerminalTabRevealedAtById.set(tabId, now)
      noteTerminalTabEnteredForeground(tabId)
    }
  }
}

function normalizeTerminalTabIds(tabIds: Iterable<string | null | undefined>): Set<string> {
  return new Set(
    Array.from(tabIds).filter(
      (tabId): tabId is string => typeof tabId === 'string' && tabId.length > 0
    )
  )
}

export function setForegroundTerminalTabIds(tabIds: Iterable<string | null | undefined>): void {
  const previousForegroundTerminalTabIds = new Set(getForegroundTerminalTabIds())
  explicitForegroundTerminalTabIds = normalizeTerminalTabIds(tabIds)
  const now = Date.now()
  for (const tabId of explicitForegroundTerminalTabIds) {
    foregroundTerminalTabLastSeenAtById.set(tabId, now)
  }
  noteRevealStarts(previousForegroundTerminalTabIds, now)
  refreshExitedForegroundTerminalTabLastSeen(previousForegroundTerminalTabIds, now)
}

export function registerVisibleTerminalTab(tabId: string | null | undefined): () => void {
  const normalized = normalizeTerminalTabIds([tabId])
  const id = Array.from(normalized)[0]
  if (!id) {
    return () => {}
  }

  // Why: multiple visible panes can belong to one terminal tab; tokenized claims
  // let each pane clean up without dropping sibling foreground protection.
  const token = Symbol(id)
  const previousForegroundTerminalTabIds = new Set(getForegroundTerminalTabIds())
  visibleTerminalTabClaimsByToken.set(token, id)
  const now = Date.now()
  foregroundTerminalTabLastSeenAtById.set(id, now)
  noteRevealStarts(previousForegroundTerminalTabIds, now)
  return () => {
    if (!visibleTerminalTabClaimsByToken.delete(token)) {
      return
    }
    if (!getForegroundTerminalTabIds().includes(id)) {
      // Why: keep the sleep timer anchored to the end of the full foreground visit.
      foregroundTerminalTabLastSeenAtById.set(id, Date.now())
    }
  }
}

export function getForegroundTerminalTabIds(): string[] {
  // Why: hibernation already reasons by terminal tab, so visible pane claims
  // join the page-level foreground set instead of adding pane rules.
  return Array.from(
    new Set([...explicitForegroundTerminalTabIds, ...visibleTerminalTabClaimsByToken.values()])
  )
}

export function getForegroundTerminalTabLastSeenAtById(): Record<string, number> {
  return Object.fromEntries(foregroundTerminalTabLastSeenAtById)
}

/** When the tab's current or most recent foreground visit began (a person revealed it). */
export function getForegroundTerminalTabRevealedAt(tabId: string): number | undefined {
  return foregroundTerminalTabRevealedAtById.get(tabId)
}

// Why: retired terminal tab ids never recur, so their last-seen timestamps would
// accumulate for the renderer's whole session. Drop them when a tab is closed or
// its worktree is removed.
export function forgetForegroundTerminalTabs(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    foregroundTerminalTabLastSeenAtById.delete(tabId)
    foregroundTerminalTabRevealedAtById.delete(tabId)
  }
}

export function resetForegroundTerminalTabIdsForTests(): void {
  explicitForegroundTerminalTabIds = new Set()
  visibleTerminalTabClaimsByToken.clear()
  foregroundTerminalTabLastSeenAtById.clear()
  foregroundTerminalTabRevealedAtById.clear()
}

function refreshExitedForegroundTerminalTabLastSeen(
  previousForegroundTerminalTabIds: Set<string>,
  now: number
): void {
  const currentForegroundTerminalTabIds = new Set(getForegroundTerminalTabIds())
  for (const tabId of previousForegroundTerminalTabIds) {
    if (!currentForegroundTerminalTabIds.has(tabId)) {
      // Why: visible panes can keep a terminal tab foreground after explicit ids change.
      foregroundTerminalTabLastSeenAtById.set(tabId, now)
    }
  }
}
