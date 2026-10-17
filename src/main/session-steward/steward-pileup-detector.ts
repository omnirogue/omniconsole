/**
 * The "piling up" count (D7-A), at the end of each rules pass: what the rules could not settle
 * (Stalled sessions, and finished ones Tier 2 would not archive after 6 quiet hours). Past the
 * threshold, or with anything Stalled for a day, it asks for one automatic cleanup session. WP-S4
 * owns the run (reservation, daily cap, capacity) and registers it with
 * `setStewardCleanupStarter`; until then the detector only counts.
 */

import { stewardFeatureOn } from './steward-switches'

export type StewardLeftover = {
  paneKey: string
  title: string
  kind: 'stalled' | 'finished-held'
  reason: string
  /** When it became a leftover (Stalled) or last had activity (finished). */
  since: number
}

export type StewardCleanupStart = { ok: true; runId?: string } | { ok: false; reason: string }

export type StewardCleanupStarter = (request: {
  source: 'automatic'
  leftovers: StewardLeftover[]
}) => Promise<StewardCleanupStart>

export const STEWARD_STALLED_URGENT_MS = 24 * 60 * 60_000
/** A refused or failed request is asked again no sooner than this. */
export const STEWARD_DETECTOR_RETRY_MS = 30 * 60_000

let starter: StewardCleanupStarter | null = null

/** WP-S4 registers the automatic cleanup run; returns the restore. */
export function setStewardCleanupStarter(next: StewardCleanupStarter | null): () => void {
  const previous = starter
  starter = next
  return () => {
    starter = previous
  }
}

/** Why the leftovers call for a cleanup now, or null when they do not. */
export function stewardPileupReason(
  leftovers: readonly StewardLeftover[],
  threshold: number,
  now: number
): string | null {
  if (leftovers.length >= threshold) {
    return `${leftovers.length} sessions the rules could not settle (threshold ${threshold})`
  }
  const old = leftovers.find(
    (leftover) => leftover.kind === 'stalled' && now - leftover.since >= STEWARD_STALLED_URGENT_MS
  )
  return old ? `“${old.title}” has been Stalled for more than a day` : null
}

export class StewardPileupDetector {
  private lastAttemptAt: number | null = null

  constructor(
    private readonly deps: {
      now: () => number
      threshold: () => number
      /** False until the window has listed its sessions once (the count would be partial). */
      ready?: () => boolean
      note: (summary: string) => void
    }
  ) {}

  /** One request at most per `STEWARD_DETECTOR_RETRY_MS`; the run itself dedupes (WP-S4). */
  async run(leftovers: readonly StewardLeftover[]): Promise<void> {
    const now = this.deps.now()
    const why = stewardPileupReason(leftovers, this.deps.threshold(), now)
    if (
      !why ||
      !starter ||
      this.deps.ready?.() === false ||
      !stewardFeatureOn('automaticCleanup') ||
      (this.lastAttemptAt !== null && now - this.lastAttemptAt < STEWARD_DETECTOR_RETRY_MS)
    ) {
      return
    }
    this.lastAttemptAt = now
    let started: StewardCleanupStart
    try {
      started = await starter({ source: 'automatic', leftovers: [...leftovers] })
    } catch (error) {
      started = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.deps.note(
      started.ok
        ? `Started a cleanup session: ${why}.`
        : `No cleanup session started (${started.reason}): ${why}.`
    )
  }
}
