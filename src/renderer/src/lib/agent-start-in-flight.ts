// Why: main admits at most N agent starts per rolling 10 s app-wide, so a pane's start can sit in
// that queue for a while before its PTY exists. Callers that wait for a tab's PTY with a fixed
// budget (the launch-prompt paste waits 8 s) must not read "still queued" as "the launch failed".
// Keyed by tab, counted per pane, and released when the pane's connect settles or it is disposed.

const inFlightCountByTabId = new Map<string, number>()

/** Marks one agent start of this tab as waiting for its PTY; returns the idempotent release. */
export function markAgentStartInFlight(tabId: string): () => void {
  inFlightCountByTabId.set(tabId, (inFlightCountByTabId.get(tabId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const next = (inFlightCountByTabId.get(tabId) ?? 1) - 1
    if (next > 0) {
      inFlightCountByTabId.set(tabId, next)
    } else {
      inFlightCountByTabId.delete(tabId)
    }
  }
}

export function isAgentStartInFlightForTab(tabId: string): boolean {
  return (inFlightCountByTabId.get(tabId) ?? 0) > 0
}

// Why: a pane whose agent start was still queued when the pane went away (unmounted, remounted)
// has that start cancelled in main without using a slot. Whoever asked for the mount (the
// interrupted-restore auto-continue) must hear of it, or the mid-task agent never resumes.
const abandonedStartListeners = new Set<(paneKey: string) => void>()

/** Main dropped this pane's queued agent start because its pane went away. */
export function noteAgentStartAbandoned(paneKey: string): void {
  for (const listener of Array.from(abandonedStartListeners)) {
    try {
      listener(paneKey)
    } catch {
      // A listener's failure must not stop the others.
    }
  }
}

export function subscribeAgentStartAbandoned(listener: (paneKey: string) => void): () => void {
  abandonedStartListeners.add(listener)
  return () => {
    abandonedStartListeners.delete(listener)
  }
}

export function resetAgentStartsInFlightForTests(): void {
  inFlightCountByTabId.clear()
  abandonedStartListeners.clear()
}
