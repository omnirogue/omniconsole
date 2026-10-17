/**
 * The computer a session slept on, before it wakes that session and on every pass while it sleeps
 * with a copy up (PLAN section 4, "When the original computer comes back"): another computer that
 * claimed the wake owns it. While that wake runs this one waits; once it is done this computer gives
 * the conversation up for good (relocate's rule), forgets the pane's sleep checkpoint so opening the
 * tab starts nothing, files the row away as moved, and keeps the transcript as history.
 */

import { wakeCopyMayExist, type ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import type { WakeClaim, WakeCopyApiResult } from './review-wake-copy-api'

export type WakeClaimOwnerDeps = {
  /** The claim on exactly this revision (OmniOS keeps it after the copy is gone). */
  readClaim(slug: string, revision: number): Promise<WakeCopyApiResult<WakeClaim | null>>
  /** This computer's own host id; a claim it made itself is not "elsewhere". */
  hostId(): string | null
  /** Only a window can drop the pane's checkpoint; without one the move is finished later. */
  windowAttached(): boolean
  yieldConversation(
    sleep: ArtifactReviewSleep,
    sessionId: string,
    claim: WakeClaim
  ): Promise<{ status: 'ok' } | { status: 'refused'; reason: string }>
  /** A pane holding the conversation runs it here; null when that cannot be told. */
  running(entry: SourceReviewEntry, sleep: ArtifactReviewSleep): Promise<boolean | null>
  /** The window drops a parked pane's checkpoint (true; also when it has none); false when live. */
  forgetSleptPane(paneKey: string): Promise<boolean>
  archiveOwnRow(entry: SourceReviewEntry, reason: string): Promise<void>
  saveSleep(entry: SourceReviewEntry, sleep: ArtifactReviewSleep): boolean
  now(): number
}

function settle(
  deps: Pick<WakeClaimOwnerDeps, 'saveSleep' | 'now'>,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep,
  next: Pick<ArtifactReviewSleep, 'state' | 'reason' | 'movedTo'>
): void {
  // Why compare first: an unchanged record is not saved (or reported) again every pass.
  if (sleep.state === next.state && sleep.reason === next.reason) {
    return
  }
  const { reason: _reason, retryAfter: _retryAfter, ...rest } = sleep
  deps.saveSleep(entry, { ...rest, ...next, at: deps.now() })
}

/** Why this computer must not wake it now, or null when it may (no claim, or its own). */
export async function wakeClaimElsewhere(
  deps: WakeClaimOwnerDeps,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep
): Promise<string | null> {
  const read = await deps.readClaim(entry.slug, sleep.revision)
  if (read.status !== 'ok') {
    // Why: without a copy no other computer can have taken it; an OmniOS without the route can
    // only hold one this computer saw it confirm (a rollback), never a merely pending upload.
    const held =
      read.status === 'unsupported' ? Boolean(sleep.wakeCopy?.sha256) : wakeCopyMayExist(sleep)
    return held ? 'OmniOS could not say whether another computer took it' : null
  }
  const claim = read.value
  if (!claim || claim.revision !== sleep.revision || claim.hostId === deps.hostId()) {
    return null
  }
  if (!claim.done) {
    return `it is waking on ${claim.host}`
  }
  const moved = `Moved to ${claim.host}`
  const running = await deps.running(entry, sleep)
  if (running) {
    // It runs here too (a person opened it): never stopped automatically, nor given up while it runs.
    const reason = `${moved}, but it was opened here again`
    settle(deps, entry, sleep, { state: 'stalled', reason })
    return reason
  }
  if (running === null) {
    return `${moved}; it is given up here once nothing can be running it`
  }
  const yielded = await deps.yieldConversation(sleep, entry.sourceReview.nativeSessionId, claim)
  if (yielded.status !== 'ok') {
    return `it moved to ${claim.host}, but ${yielded.reason}`
  }
  if (!deps.windowAttached()) {
    // The registry already refuses every resume path here; the window step follows when it opens.
    return moved
  }
  if (!(await deps.forgetSleptPane(entry.sourceReview.paneKey))) {
    return `${moved}, but its tab here is starting`
  }
  try {
    await deps.archiveOwnRow(entry, `${moved}; its history stays here`)
  } catch {
    // Every step above is idempotent: the next pass archives it again.
    return moved
  }
  settle(deps, entry, sleep, { state: 'moved', reason: moved, movedTo: { host: claim.host } })
  return moved
}
