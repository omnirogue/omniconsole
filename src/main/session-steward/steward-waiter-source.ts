/**
 * Which sessions other sessions wait on: WP-S3's `listSessionWaiters`, keyed by the awaited
 * session's reference (a session key or pane key) with the waiters' pane keys. Until it is
 * registered no session reads as awaited. Tier 2, Tier 1's archive proof and `session list` ask
 * here, so none of them needs to know where the waits live.
 */

export type SessionWaiters = ReadonlyMap<string, readonly string[]>

let source: (() => SessionWaiters) | null = null

/** Returns the restore. A source that throws counts as "waited on" by an unknown waiter. */
export function setSessionWaitersSource(next: (() => SessionWaiters) | null): () => void {
  const previous = source
  source = next
  return () => {
    source = previous
  }
}

export const UNREADABLE_WAITERS = 'waiters could not be read'

/** The waiters of a session named by any of its keys; empty when nothing waits on it. */
export function sessionWaitersOf(keys: readonly (string | null | undefined)[]): string[] {
  if (!source) {
    return []
  }
  let waiters: SessionWaiters
  try {
    waiters = source()
  } catch {
    // Why fail closed: an unreadable index must never let an awaited session be archived.
    return [UNREADABLE_WAITERS]
  }
  const found = new Set<string>()
  for (const key of keys) {
    for (const waiter of (key && waiters.get(key)) || []) {
      found.add(waiter)
    }
  }
  return [...found]
}
