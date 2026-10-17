/**
 * What the reviewers said, for the work that runs after their review.
 *
 * The work queued behind a review is released once every reviewer approved, and what they
 * wrote with their OK is part of what that work is for — so the host carries every answer into
 * the released stages' own instruction (`up-next-continuation.ts`). The decision is read from the
 * receipt that counted the reply (`handoff-review:<thread>:<review>:<decision>`,
 * `session-outcome-external-evidence.ts`), and the note from the same hub thread the verifier
 * read. A note that cannot be read refuses the release, which the host asks again every pass:
 * the stage never runs without the words it was queued to act on.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import {
  SESSION_RUN_REVIEW_NOTE_MAX_CHARS,
  sessionReviewReceiptReply
} from '../../shared/session-run-held-continuation'
import { sessionOutcomeHandoffReader } from './session-outcome-external-evidence'
import { upNextReviewAnswers } from './up-next-person-facts'
import { artifactReviewDecisionNote } from './session-outcome-artifact-review'

export const UP_NEXT_REVIEW_BRIEF_HEADING = 'What the reviewers replied:'

const DECISION_WORDS = { approve: 'approved', request_changes: 'requested changes' } as const

/**
 * The note a reviewer wrote with the reply `receipt` counted; undefined when they wrote none or
 * the receipt is not a hub reply. Throws when the thread cannot be read, so a caller never acts
 * on a reply without its words.
 */
export async function upNextReviewNote(receipt: string): Promise<string | undefined> {
  const reply = sessionReviewReceiptReply(receipt)
  // A decision made on the reviewed page carries its words on the page, not on the thread.
  const page = reply ? await artifactReviewDecisionNote(reply.reviewId) : null
  const note = page === null ? await hubReviewNote(reply) : page
  if (!note) {
    return undefined
  }
  return note.length > SESSION_RUN_REVIEW_NOTE_MAX_CHARS
    ? `${note.slice(0, SESSION_RUN_REVIEW_NOTE_MAX_CHARS - 1)}…`
    : note
}

async function hubReviewNote(
  reply: ReturnType<typeof sessionReviewReceiptReply>
): Promise<string | undefined> {
  // No transport, no words to fetch: the receipt still says who answered and how.
  const read = sessionOutcomeHandoffReader()
  if (!reply || !read) {
    return undefined
  }
  const result = await read({ threadId: reply.threadId })
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data.reviews.find((review) => review.id === reply.reviewId)?.note?.trim()
}

/**
 * The brief for the review step `stepId` of `chain`: one line per reviewer who answered, with
 * their decision and their note. Empty when nobody's answer can be read off the chain.
 */
export async function upNextReviewReplyBrief(chain: SessionChain, stepId: string): Promise<string> {
  const answers = upNextReviewAnswers(chain, stepId)
  if (!answers.length) {
    return ''
  }
  const lines = [UP_NEXT_REVIEW_BRIEF_HEADING]
  for (const answer of answers) {
    const note = await upNextReviewNote(answer.receipt)
    lines.push(`- ${answer.name}: ${DECISION_WORDS[answer.decision]}`)
    if (note) {
      lines.push(...note.split('\n').map((line) => `  ${line}`))
    }
  }
  return lines.join('\n')
}
