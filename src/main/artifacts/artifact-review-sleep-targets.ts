import { REVIEW_WAIT_OLD_MS } from '../../shared/artifact-review-waits'
import { basename } from 'node:path'
import {
  getEffectiveReviewWaitLiveMinutes,
  validArtifactReviewSleep,
  type ArtifactReviewSleep,
  type ReviewSleepTarget
} from '../../shared/artifact-review-sleep'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { listArtifactShareRecords } from './artifact-share-record-store'
import { activeArtifactShareScope } from './artifact-share-scope'
import { saveArtifactReviewSleep } from './artifact-share-record-sleep'
import { validArtifactSourceReview, type ArtifactSourceReview } from './artifact-source-review'
import {
  validArtifactReviewAttention,
  type ArtifactReviewAttention
} from './artifact-review-attention'

export type ReviewSleepEntry = {
  sourceKey: string
  slug: string
  sourceReview: ArtifactSourceReview
  sleep: ArtifactReviewSleep
  shareUrl?: string
  /** The published file's name; the page title lives on OmniOS. */
  title?: string
  reviewAttention?: ArtifactReviewAttention
}

/** Share records on this desktop whose publishing session waits on, or sleeps for, a review. */
export function listReviewSleepEntries(
  apiOrigin: string | null,
  userDataPath = getProfileUserDataPath()
): ReviewSleepEntry[] {
  const active = activeArtifactShareScope(userDataPath, apiOrigin)
  if (!active) {
    return []
  }
  return listArtifactShareRecords(active.profileId, userDataPath, active.scope).flatMap(
    ([sourceKey, record]) =>
      validArtifactSourceReview(record.sourceReview) &&
      validArtifactReviewSleep(record.sleep) &&
      record.sleep.revision === record.sourceReview.revision
        ? [
            {
              sourceKey,
              slug: record.slug,
              sourceReview: record.sourceReview,
              sleep: record.sleep,
              ...(validArtifactReviewAttention(record.reviewAttention)
                ? { reviewAttention: record.reviewAttention }
                : {}),
              shareUrl: record.shareUrl,
              title: basename(sourceKey)
            }
          ]
        : []
  )
}

/** The panes the hibernation timer may sleep after the review wait instead of its own window. */
export function listReviewSleepTargets(
  settings: { reviewWaitLiveMinutes?: number },
  entries: readonly ReviewSleepEntry[]
): ReviewSleepTarget[] {
  const idleMs = getEffectiveReviewWaitLiveMinutes(settings.reviewWaitLiveMinutes) * 60_000
  const waking = new Set(
    entries
      .filter((entry) => entry.sleep.state === 'waking')
      .map((entry) => entry.sourceReview.paneKey)
  )
  const byPane = new Map<string, ReviewSleepTarget>()
  for (const entry of entries) {
    const { paneKey, worktreeId } = entry.sourceReview
    // Why skip a waking pane: a decision is being delivered to it right now.
    if (entry.sleep.state !== 'waiting' || waking.has(paneKey) || byPane.has(paneKey)) {
      continue
    }
    const { model, effort } = entry.sleep
    byPane.set(paneKey, {
      worktreeId,
      paneKey,
      idleMs,
      ...(model || effort
        ? { launchOptions: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } }
        : {})
    })
  }
  return [...byPane.values()]
}

/**
 * A pane that waited on its reviews was slept or its terminal ended: those waits now read asleep.
 * Without a worktree id the pane key alone names it (a terminal teardown carries only that).
 */
export function noteReviewSessionAsleep(
  target: { paneKey: string; worktreeId?: string },
  apiOrigin: string | null,
  now = Date.now(),
  userDataPath = getProfileUserDataPath()
): number {
  const active = activeArtifactShareScope(userDataPath, apiOrigin)
  if (!active) {
    return 0
  }
  let noted = 0
  for (const entry of listReviewSleepEntries(apiOrigin, userDataPath)) {
    if (
      entry.sleep.state === 'waiting' &&
      entry.sourceReview.paneKey === target.paneKey &&
      (target.worktreeId === undefined || entry.sourceReview.worktreeId === target.worktreeId) &&
      saveArtifactReviewSleep(
        active.profileId,
        userDataPath,
        entry.sourceKey,
        active.scope,
        entry,
        {
          ...entry.sleep,
          state: 'asleep',
          sleptAt: now,
          at: now
        }
      )
    ) {
      noted += 1
    }
  }
  return noted
}

/**
 * Waits a quit app keeps advancing headless: a live session waiting for its decision, which is
 * delivered to it and which the headless pass puts to sleep after the review wait. An asleep or
 * stalled one needs a window (or another computer) and a week-old one is abandoned, so neither
 * keeps a window-less process running.
 */
export function countOpenReviewWaits(
  apiOrigin: string | null,
  userDataPath = getProfileUserDataPath(),
  now = Date.now()
): number {
  try {
    return countAdvanceableReviewWaits(listReviewSleepEntries(apiOrigin, userDataPath), now)
  } catch {
    return 0
  }
}

export function countAdvanceableReviewWaits(
  entries: readonly ReviewSleepEntry[],
  now: number
): number {
  return entries.filter(
    (entry) => entry.sleep.state === 'waiting' && now - entry.sleep.at <= REVIEW_WAIT_OLD_MS
  ).length
}
