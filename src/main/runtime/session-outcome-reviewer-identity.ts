import { createHash } from 'node:crypto'
import type { SessionReviewAssignment } from '../../shared/session-chain-review'

export function sessionOutcomeReviewerIdentity(
  review: Pick<SessionReviewAssignment, 'groupId' | 'reviewerId'>
): string {
  return `reviewer_${createHash('sha256')
    .update(`${review.groupId}:${review.reviewerId}`)
    .digest('hex')
    .slice(0, 24)}`
}
