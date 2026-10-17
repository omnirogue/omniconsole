import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { type ArtifactShareScope, updateArtifactShareRecord } from './artifact-share-record-store'
import type { ArtifactSourceReview } from './artifact-source-review'

type Expected = { slug: string; sourceReview: ArtifactSourceReview }

function sameBinding(left: ArtifactSourceReview | undefined, right: ArtifactSourceReview): boolean {
  const { receipt: _left, ...leftIdentity } = left ?? ({} as ArtifactSourceReview)
  const { receipt: _right, ...rightIdentity } = right
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity)
}

/** Replaces (or with null removes) the sleep block while the record still names this binding. */
export function saveArtifactReviewSleep(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: Expected,
  sleep: ArtifactReviewSleep | null
): boolean {
  return (
    updateArtifactShareRecord(profileId, userDataPath, sourceKey, scope, (current) => {
      if (
        current.slug !== expected.slug ||
        !sameBinding(current.sourceReview, expected.sourceReview)
      ) {
        return null
      }
      const { sleep: _old, ...rest } = current
      return sleep ? { ...rest, sleep } : rest
    }) !== null
  )
}

/** Moves a woken conversation's binding to the pane it now runs in; receipts and sleep stay. */
export function rebindArtifactSourceReview(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: Expected,
  next: Pick<ArtifactSourceReview, 'ledgerId' | 'paneKey' | 'worktreeId'>
): ArtifactSourceReview | null {
  const saved = updateArtifactShareRecord(profileId, userDataPath, sourceKey, scope, (current) =>
    current.sourceReview &&
    current.slug === expected.slug &&
    sameBinding(current.sourceReview, expected.sourceReview)
      ? { ...current, sourceReview: { ...current.sourceReview, ...next } }
      : null
  )
  return saved?.sourceReview ?? null
}

/** Sets only the wake copy, on the wait as it is now, and only for that revision's wait. */
export function saveArtifactReviewWakeCopy(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: Expected,
  wakeCopy: NonNullable<ArtifactReviewSleep['wakeCopy']>
): boolean {
  return (
    updateArtifactShareRecord(profileId, userDataPath, sourceKey, scope, (current) =>
      current.slug === expected.slug &&
      sameBinding(current.sourceReview, expected.sourceReview) &&
      current.sleep?.revision === wakeCopy.revision
        ? { ...current, sleep: { ...current.sleep, wakeCopy } }
        : null
    ) !== null
  )
}

/**
 * A person opened a slept session again: no copy is kept, and it is never copied again for this
 * revision; the wait stays `asleep`, so a decision still wakes it here once it is closed again.
 */
export function markArtifactReviewReopened(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: Expected & { sleep: Pick<ArtifactReviewSleep, 'revision'> }
): boolean {
  return (
    updateArtifactShareRecord(profileId, userDataPath, sourceKey, scope, (current) => {
      const sleep = current.sleep
      if (
        current.slug !== expected.slug ||
        !sameBinding(current.sourceReview, expected.sourceReview) ||
        sleep?.state !== 'asleep' ||
        sleep.revision !== expected.sleep.revision
      ) {
        return null
      }
      const { wakeCopy: _copy, ...rest } = sleep
      return { ...current, sleep: { ...rest, reopened: true } }
    }) !== null
  )
}
