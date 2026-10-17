/**
 * What a person block is actually waiting for.
 *
 * A REVIEW is not finished because the request was delivered: it is finished when the
 * person answered. Each named reviewer has their own `review` condition on the Outcome
 * (`next-outcome-definition-compile.ts`), so "1 of 2 replied" is counted from RECEIPTS at
 * the current revision — the same rule that decides every other kind of progress
 * (`docs/outcome-model-frozen.md` §5 invariant 4). Delivery alone counts for nothing.
 *
 * The receipt carries the decision (`session-outcome-external-evidence.ts`): only an approval
 * of the current version opens what is held behind the review, and a request for changes goes
 * back to the agent first (`up-next-review-fix.ts`). The host reads the same thing when it
 * decides whether a continuation may run, so "they said OK" cannot mean two things in one build.
 */

import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeEvidence } from '../../shared/session-outcome-types'
import { isSessionReviewAsk, sessionReviewLatestAsk } from '../../shared/session-review-ask'
import {
  openSessionReviewFixes,
  sessionReviewDecision,
  spentSessionReviewReceipts,
  type SessionReviewDecision
} from '../../shared/session-run-held-continuation'
import type { UpNextPersonBlock, UpNextReviewWaiting } from '../../shared/up-next-types'

export type UpNextReviewReplies = UpNextReviewWaiting & {
  approved: number
  round: number
  fixing: boolean
}

/** One named reviewer who has answered this ask, how, and the receipt that counted the answer. */
export type UpNextReviewAnswer = {
  employeeId: string
  name: string
  receipt: string
  decision: SessionReviewDecision
}

type AskedReview = {
  step: SessionChainHandoffStep
  /** A newer ask of one of its people, in the Outcome that owns it, replaced this one. */
  replaced: boolean
  answers: { employeeId: string; answer?: SessionOutcomeEvidence }[]
}

/**
 * The newer ticked Review of `employeeId`, among the asks of `outcome` (the Outcome that owns
 * `step`), that replaced `step` (`session-review-ask.ts`); undefined while `step` is their newest.
 * A Hand off, or a retired ask, is never replaced: it was never the ask their review answers.
 */
function replacedBy(
  chain: SessionChain | null,
  step: SessionChainHandoffStep,
  outcome: SessionOutcome,
  employeeId: string
): SessionChainHandoffStep | undefined {
  // Why the step joins the scope: an Outcome that does not list it still compares only its own asks.
  const scope = outcome.stepIds && [...outcome.stepIds, step.id]
  const latest = isSessionReviewAsk(step)
    ? sessionReviewLatestAsk(chain, employeeId, scope)
    : undefined
  return latest && latest.id !== step.id ? latest : undefined
}

/**
 * The review conditions the step `stepId` asked, each with the receipt that answers it at the
 * current revision. Absent when that step is not a review the host can count.
 */
function askedReview(chain: SessionChain | null, stepId: string): AskedReview | undefined {
  const step = chain?.steps.find((entry) => entry.id === stepId)
  if (step?.kind !== 'handoff') {
    return undefined
  }
  const ids = new Set(step.handoff.recipients.map((recipient) => recipient.employeeId))
  const asked = (outcome: SessionOutcome): SessionOutcome['conditions'] =>
    outcome.conditions.filter(
      (condition) =>
        condition.kind === 'review' && condition.recipientId && ids.has(condition.recipientId)
    )
  // The outcome that OWNS this review, not whichever happens to be first: a set may carry more
  // than one, and only the one holding this step (or these reviewers' conditions) can answer.
  const outcomes = chain?.outcomeSet?.outcomes ?? []
  const outcome =
    outcomes.find((entry) => (entry.stepIds ?? []).includes(stepId) && asked(entry).length) ??
    outcomes.find((entry) => asked(entry).length)
  if (!outcome) {
    return undefined
  }
  // An answer to a version the work no longer is (its round was asked again) answers nothing now.
  const spent = spentSessionReviewReceipts(chain?.outcomeSet?.heldContinuation)
  const answers = asked(outcome).map((condition) => {
    const newer = replacedBy(chain, step, outcome, condition.recipientId!)
    const until = newer?.handoff.savedAt ?? Number.POSITIVE_INFINITY
    return {
      employeeId: condition.recipientId!,
      answer: outcome.evidence.find(
        (receipt) =>
          receipt.conditionId === condition.id &&
          receipt.outcomeRevision === outcome.revision &&
          // A reply to THIS ask arrived after it was sent. One person has ONE review condition
          // however many times they are asked, so a second review of the same reviewer would
          // otherwise read their answer to the FIRST request as its own — and release the work
          // held behind it the moment the request went out.
          receipt.verifiedAt >= step.handoff.savedAt &&
          // Why bounded: once a newer ask of theirs replaced this one, a later reply answers THAT.
          receipt.verifiedAt < until &&
          !spent.has(receipt.receipt)
      )
    }
  })
  const replaced = step.handoff.recipients.some((person) =>
    Boolean(replacedBy(chain, step, outcome, person.employeeId))
  )
  return { step, replaced, answers }
}

function nameOf(step: SessionChainHandoffStep, employeeId: string): string {
  return (
    step.handoff.recipients.find((recipient) => recipient.employeeId === employeeId)?.name ||
    employeeId
  )
}

/**
 * Where the review step `stepId` stands: replies in, replies expected, how long the first request
 * has been out, how many said OK, and every "needs changes" with its note. Absent when that step
 * is not a review the host can count.
 */
export function upNextReviewReplies(
  chain: SessionChain | null,
  stepId: string,
  now: number
): UpNextReviewReplies | undefined {
  const review = askedReview(chain, stepId)
  if (!review) {
    return undefined
  }
  const { step } = review
  const answers = upNextReviewAnswers(chain, stepId)
  const sent = step.handoff.recipients
    .map((recipient) => recipient.at)
    .filter((at): at is number => typeof at === 'number')
  const since = sent.length ? Math.min(...sent) : step.handoff.savedAt
  const hold = chain?.outcomeSet?.heldContinuation
  const fixes = (hold?.fixes ?? []).filter((fix) => fix.stepId === stepId)
  return {
    replied: answers.length,
    total: review.answers.length,
    sinceMs: Math.max(0, now - since),
    approved: answers.filter((answer) => answer.decision === 'approve').length,
    round: Math.max(1, ...step.handoff.recipients.map((recipient) => recipient.round ?? 1)),
    // The agent has the notes and its turn has not ended.
    fixing: openSessionReviewFixes(hold).some(
      (fix) => fix.stepId === stepId && fix.deliveredAt !== undefined && !fix.failed
    ),
    answers: answers.map(({ employeeId, name, decision }) => ({ employeeId, name, decision })),
    changes: fixes.map((fix) => ({
      employeeId: fix.employeeId,
      name: nameOf(step, fix.employeeId),
      round: fix.round,
      ...(fix.note ? { note: fix.note } : {})
    }))
  }
}

/** Who has answered the review step `stepId`, and how, by the same receipts that count the replies. */
export function upNextReviewAnswers(
  chain: SessionChain | null,
  stepId: string
): UpNextReviewAnswer[] {
  const review = askedReview(chain, stepId)
  return (review?.answers ?? []).flatMap(({ employeeId, answer }) =>
    answer
      ? [
          {
            employeeId,
            name: nameOf(review!.step, employeeId),
            receipt: answer.receipt,
            decision: sessionReviewDecision(answer.receipt)
          }
        ]
      : []
  )
}

/** Every named reviewer has answered this round, at the revision they were asked under. */
export function upNextReviewAnswered(chain: SessionChain | null, stepId: string): boolean {
  const replies = upNextReviewReplies(chain, stepId, 0)
  return Boolean(replies && replies.total > 0 && replies.replied >= replies.total)
}

/**
 * A Review a newer ask of one of its people replaced, in the Outcome that owns it
 * (`session-review-ask.ts`): their answer to it is history and the newer ask is the gate, so it
 * is not out, it reads as done, and it takes none of the newer ask's answers as its own.
 */
export function upNextReviewReplaced(chain: SessionChain | null, stepId: string): boolean {
  return askedReview(chain, stepId)?.replaced === true
}

/**
 * The review needs nothing more: every named reviewer approved the current version, or a newer
 * ask of one of them replaced it. A run an older build sealed on the last reply, whatever it
 * said, is over — its answers are final.
 */
export function upNextReviewSettled(chain: SessionChain | null, stepId: string): boolean {
  if (upNextReviewReplaced(chain, stepId)) {
    return true
  }
  const replies = upNextReviewReplies(chain, stepId, 0)
  if (!replies || replies.total === 0) {
    return false
  }
  return chain?.outcomeSet?.completion
    ? replies.replied >= replies.total
    : replies.approved >= replies.total
}

/**
 * A review the host can count that is still out: not every named reviewer approved the current
 * version. "Needs changes" is not a return — the agent fixes the work and they are asked again —
 * so it holds what was composed behind it and the run it belongs to (`up-next-held-gates.ts`).
 * Only a ticked Review is ever out, and not one a newer ask replaced (`upNextReviewReplaced`).
 */
export function upNextReviewOpen(chain: SessionChain | null, stepId: string): boolean {
  const step = chain?.steps.find((entry) => entry.id === stepId)
  if (!step || !isSessionReviewAsk(step) || upNextReviewReplaced(chain, stepId)) {
    return false
  }
  return Boolean(upNextReviewReplies(chain, stepId, 0)) && !upNextReviewSettled(chain, stepId)
}

/** The same reading, for the person block the composer is showing. */
export function upNextPersonWaiting(
  chain: SessionChain | null,
  block: UpNextPersonBlock,
  now: number
): UpNextReviewReplies | undefined {
  return block.stepId ? upNextReviewReplies(chain, block.stepId, now) : undefined
}
