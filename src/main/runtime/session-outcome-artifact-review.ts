/**
 * A ticked Review ("Wait for their OK") whose request carries an omnios page is answered on the
 * PAGE, not by a hub review: the person decides there, signed in. This reads that decision into the
 * same receipt the review gate already counts (`handoff-review:<thread>:<id>:<decision>`), so what
 * the run does next — release the held work on an approval, hand the notes to the agent and ask
 * again on a change request — is exactly what a hub review would have done.
 *
 * Read with the signed-in desktop's own bearer; a host without the reader counts hub reviews only.
 */

import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import {
  artifactReviewAnswer,
  artifactReviewOutcome,
  artifactReviewReceiptId,
  handoffArtifactReviewOf,
  handoffOpenedAt,
  parseArtifactReviewReceiptId
} from '../../shared/handoff-artifact-review'

let readReview: ((slug: string) => Promise<ArtifactReviewStatus | null>) | null = null

export function installSessionOutcomeArtifactReviewReader(
  reader: ((slug: string) => Promise<ArtifactReviewStatus | null>) | null
): void {
  readReview = reader
}

/**
 * The receipt that answers a Review condition from the page the thread was opened to review, or
 * null when the thread carries no page, the page cannot be read, or nobody decided on it since the
 * request (or the answer was already spent by a re-ask).
 */
export async function artifactReviewConditionReceipt(
  threadId: string,
  entries: readonly { kind: string; created: string; references?: readonly unknown[] | null }[],
  spent: ReadonlySet<string>
): Promise<string | null> {
  const page = handoffArtifactReviewOf(entries)
  if (!page || !readReview) {
    return null
  }
  const status = await readReview(page.slug).catch(() => null)
  const answer = status ? artifactReviewAnswer(status, handoffOpenedAt(entries)) : null
  if (!answer) {
    return null
  }
  const receipt = `handoff-review:${threadId}:${artifactReviewReceiptId(page.slug, String(answer.id))}:${artifactReviewOutcome(answer.decision)}`
  return spent.has(receipt) ? null : receipt
}

/**
 * The words a page decision carried, for a receipt this module wrote: `undefined` when there were
 * none, `null` when `reviewId` is not a page decision. Throws when the page cannot be read, so the
 * run never acts on a decision without its words (the hub path refuses the same way).
 */
export async function artifactReviewDecisionNote(
  reviewId: string
): Promise<string | undefined | null> {
  const page = parseArtifactReviewReceiptId(reviewId)
  if (!page) {
    return null
  }
  if (!readReview) {
    return undefined
  }
  const status = await readReview(page.slug)
  if (!status) {
    throw new Error(
      'The reviewed page could not be read, so the reviewer’s words are not known yet.'
    )
  }
  const decision = status.decisions.find(
    (entry) =>
      artifactReviewReceiptId(page.slug, String(entry.id)) ===
      artifactReviewReceiptId(page.slug, page.decisionId)
  )
  return decision?.comment.trim() || undefined
}
