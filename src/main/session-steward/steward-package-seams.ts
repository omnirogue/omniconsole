/**
 * The rules loop's seams, filled by the other Phase 2 packages: WP-S3's waiters index (read by
 * Tier 1, Tier 2 and `session list`) and its result-card reader (a Tier 2 card meets a waiter's
 * wait), and WP-S4's automatic cleanup run (asked by the pile-up detector).
 */

import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { admitCleanupRun } from './cleanup-runs-runtime'
import { installSessionResultCardReader } from './steward-awaited-session'
import { setStewardCleanupStarter, type StewardCleanupStart } from './steward-pileup-detector'
import type { StewardResultCardStore } from './steward-result-card'
import { setSessionWaitersSource, type SessionWaiters } from './steward-waiter-source'
import { listSessionWaiters, type SessionWaiters as SessionWaitersIndex } from './steward-waiters'

/** Awaited session → the panes waiting on it. */
export function waiterPaneKeys(index: SessionWaitersIndex): SessionWaiters {
  return new Map(
    [...index].map(([awaited, waiters]) => [awaited, waiters.map((waiter) => waiter.paneKey)])
  )
}

/** One automatic run through WP-S4's reservation (one at a time, 3 a day, capacity-aware). */
export function startAutomaticCleanup(
  leftovers: readonly { paneKey: string }[]
): StewardCleanupStart {
  const admission = admitCleanupRun('automatic', {
    leftovers: leftovers.map((leftover) => leftover.paneKey)
  })
  return admission.ok
    ? { ok: true, runId: admission.reservationId }
    : { ok: false, reason: admission.detail }
}

/** Returns the restore. */
export function registerStewardPackageSeams(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains'>,
  cards: Pick<StewardResultCardStore, 'readingForPane'>
): () => void {
  const restores = [
    setSessionWaitersSource(() => waiterPaneKeys(listSessionWaiters(runtime))),
    installSessionResultCardReader((paneKey) => cards.readingForPane(paneKey)),
    // Why safe at start: the detector asks only once the window has listed its sessions.
    setStewardCleanupStarter(async ({ leftovers }) => startAutomaticCleanup(leftovers))
  ]
  return () => {
    for (const restore of restores.toReversed()) {
      restore()
    }
  }
}
