import { sessionOutcomeResultBody as resultBody } from './session-outcome-result'
import { transitionSessionReviewRound } from '../../shared/session-chain-review-transition'
import {
  isSessionVerdictStep,
  recordSessionVerdictReceipt,
  sessionVerdictConsumptionKey,
  sessionVerdictSkipReceipt,
  verdictInvariantProblems
} from '../../shared/session-chain-verdict-receipts'
import type { SessionReviewLoopState } from '../../shared/session-chain-review'
import type { SessionChainAgentStep, SessionChainStep } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { blockOutcome, markSteps, type OutcomeStepAccess } from './session-outcome-step-progress'
import { blockOutcomeForHold } from './session-outcome-hold-write'
import { VERDICT_RECEIPT_MISSING_BLOCK } from './session-outcome-verdict-invariant'
import {
  reaskSessionOutcomeVerdicts,
  sessionOutcomeVerdictReasksLeft
} from './session-outcome-verdict-reask'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'

export function sameReviewRound(
  candidate: SessionChainStep | undefined,
  step: SessionChainAgentStep
): candidate is SessionChainAgentStep {
  return Boolean(
    step.review &&
    candidate &&
    candidate.kind !== 'handoff' &&
    candidate.review?.groupId === step.review.groupId &&
    candidate.review.round === step.review.round
  )
}

/**
 * A verdict seat may enter `completedSteps` only with a receipt, and this function is where a
 * review seat gets there without one: parked while a sibling of its round is still running, or
 * closed because the round finished without it. Both write the skip as a receipt, so
 * `verdictInvariantProblems` can tell "decided" from "merely completed".
 */
function recordVerdictSkip(
  access: OutcomeStepAccess,
  step: SessionChainStep | undefined,
  attemptId: string | undefined,
  reason: string,
  now: number
): void {
  if (!isSessionVerdictStep(step)) {
    return
  }
  const recorded = recordSessionVerdictReceipt(
    access.read(),
    sessionVerdictSkipReceipt(step, attemptId, reason, now)
  )
  if (!recorded.replayed) {
    access.save(recorded.chain)
  }
}

/**
 * A review seat the plan gave a verdict of its own receipts that decision on the chain beside the
 * round's own loop state: the loop is how a ROUND is judged, `chain.verdicts` is how a SEAT is
 * proven to have decided, and only the second is what the runtime invariant can read.
 */
function recordRoundVerdicts(
  access: OutcomeStepAccess,
  reviewers: readonly SessionChainAgentStep[],
  attempts: readonly (SessionOutcomeAttempt | undefined)[],
  loop: SessionReviewLoopState,
  groupId: string,
  round: number,
  now: number
): void {
  const judged = loop.groups
    .find((group) => group.id === groupId)
    ?.rounds.find((entry) => entry.index === round)
  for (const [index, reviewer] of reviewers.entries()) {
    const decision = judged?.receipts.find((entry) => entry.stepId === reviewer.id)
    const attemptId = attempts[index]?.id
    if (!isSessionVerdictStep(reviewer) || !decision || !attemptId) {
      continue
    }
    const recorded = recordSessionVerdictReceipt(access.read(), {
      stepId: reviewer.id,
      attemptId,
      verdict: decision,
      consumptionKey: sessionVerdictConsumptionKey(reviewer.id, attemptId),
      consumedAt: now
    })
    if (!recorded.replayed) {
      access.save(recorded.chain)
    }
  }
}

/** Judge a round only once every reviewer in it has completed, all on the same candidate. */
async function judgeReviewRound(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  now: number
): Promise<void> {
  const chain = access.read(),
    assignment = step.review!
  const reviewers = chain.steps.filter((candidate) => sameReviewRound(candidate, step))
  const attempts = reviewers.map((reviewer) =>
    chain.outcomeSet!.attempts.findLast(
      (attempt) => attempt.actionId === `step_${reviewer.id}` && attempt.state !== 'retryable'
    )
  )
  const own = attempts[reviewers.findIndex((reviewer) => reviewer.id === step.id)]
  if (own?.state !== 'completed') {
    // This seat was just asked again for its verdict: it has nothing to judge, and parking it as
    // complete would keep the seat from ever launching again.
    return
  }
  if (attempts.some((attempt) => !attempt || attempt.state !== 'completed')) {
    // The round cannot be judged yet; this seat is parked as complete, and says so.
    recordVerdictSkip(access, step, own.id, 'the round it belongs to was still running', now)
    markSteps(access, [step.id])
    return
  }
  const actual = await sessionOutcomeCandidateVersion(
    chain.workspacePath,
    // #283: the reviewed candidate includes the captured source packet's files, so a change
    // to one of them must still fail the candidate-version check.
    sessionOutcomeCandidatePaths(outcome, chain)
  )
  if (actual !== assignment.candidateVersion) {
    // Asking the same reviewers again would judge the same moved bytes against the same pin.
    blockOutcome(
      access,
      outcome.id,
      'The candidate changed during review. Reconcile the revision before continuing.',
      { class: 'failed', code: 'review-candidate-changed' },
      now
    )
    return
  }
  const repair = chain.steps.find(
    (candidate): candidate is SessionChainAgentStep =>
      candidate.kind !== 'handoff' &&
      candidate.reviewRepair?.groupId === assignment.groupId &&
      candidate.reviewRepair.afterRound === assignment.round
  )
  const transition = transitionSessionReviewRound({
    loop: chain.reviewLoop,
    assignment,
    reviewers: reviewers.map((reviewer, index) => ({
      stepId: reviewer.id,
      reviewerId: reviewer.review!.reviewerId,
      output: resultBody(access.runtime, attempts[index]!),
      attemptId: attempts[index]!.id
    })),
    hasAuthorizedRepair: Boolean(repair),
    reviewOnly: !chain.steps.some(
      (candidate) =>
        candidate.kind !== 'handoff' && candidate.reviewRepair?.groupId === assignment.groupId
    ),
    reaskable: reviewers
      .filter((reviewer) => sessionOutcomeVerdictReasksLeft(chain, outcome, reviewer.id) > 0)
      .map((reviewer) => reviewer.id),
    now
  })
  access.save({ ...chain, reviewLoop: transition.loop })
  if (transition.next === 'reask') {
    // The round stays `reviewing` and the seats beside them keep their results; the receipts of
    // the whole round are recorded when it is finally judged.
    reaskSessionOutcomeVerdicts(
      access,
      outcome,
      reviewers.flatMap((reviewer, index) =>
        transition.reask!.includes(reviewer.id) ? [attempts[index]!.id] : []
      )
    )
    return
  }
  recordRoundVerdicts(
    access,
    reviewers,
    attempts,
    transition.loop,
    assignment.groupId,
    assignment.round,
    now
  )
  if (transition.next === 'block') {
    blockOutcomeForHold(
      access,
      outcome.id,
      { kind: 'review-round', groupId: assignment.groupId, reason: transition.reason! },
      now
    )
    return
  }
  markSteps(
    access,
    reviewers.map((reviewer) => reviewer.id)
  )
  if (transition.next === 'finish') {
    const later = chain.steps.filter(
      (candidate) =>
        candidate.kind !== 'handoff' &&
        (candidate.review?.groupId === assignment.groupId ||
          candidate.reviewRepair?.groupId === assignment.groupId) &&
        !reviewers.some((reviewer) => reviewer.id === candidate.id) &&
        !chain.outcomeSet!.completedSteps?.includes(candidate.id)
    )
    for (const candidate of later) {
      recordVerdictSkip(
        access,
        candidate,
        undefined,
        `the review group ${assignment.groupId} closed`,
        now
      )
    }
    markSteps(
      access,
      later.map((candidate) => candidate.id),
      true
    )
  }
}

/** The round's own tick assertion: nothing this function completed may lack its receipt. */
export async function finishReviewRound(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  now = Date.now()
): Promise<void> {
  await judgeReviewRound(access, outcome, step, now)
  const problems = verdictInvariantProblems(access.read())
  if (problems.length) {
    blockOutcome(access, outcome.id, problems[0]!, VERDICT_RECEIPT_MISSING_BLOCK, now)
  }
}
