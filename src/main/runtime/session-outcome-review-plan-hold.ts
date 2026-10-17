import { NEXT_STEP_MAX_REVIEW_ROUNDS } from '../../shared/next-step-draft'
import { consumeSessionReviewRepair } from '../../shared/session-chain-review-transition'
import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'

/**
 * A review loop that cannot run as planned, found BEFORE any round is judged: rounds with no repair
 * owner, a repair nothing authorizes, a repair that changed nothing. These are failures of the plan
 * or of the repairer — never a verdict, and never a question for a person — so they carry codes of
 * their own instead of riding the judged round's hold.
 *
 * One derivation, two readers: the step runner asks it at the barrier, and the status recompute
 * asks the same question every pass, so the block stays in place (and keeps its `since`) instead
 * of being cleared and rewritten every tick. It clears by itself when its cause does: a new plan,
 * or a candidate that was revised after all.
 */
export type SessionOutcomeReviewPlanHold = {
  kind: 'review-plan'
  groupId: string
  code: 'review-plan-invalid' | 'review-repair-unchanged' | 'review-repair-consumed'
  reason: string
}

/** The attempt this step is running under; a retryable or superseded one is not it. */
export function sessionOutcomeStepAttempt(
  attempts: readonly SessionOutcomeAttempt[],
  stepId: string
): SessionOutcomeAttempt | undefined {
  return attempts.findLast(
    (attempt) =>
      attempt.actionId === sessionOutcomeStepActionId(stepId) &&
      attempt.state !== 'retryable' &&
      attempt.state !== 'superseded'
  )
}

/** The barrier: the outcome's first incomplete step in plan order, never one behind it. */
export function sessionOutcomeBarrierStep(
  chain: SessionChain,
  outcome: SessionOutcome
): SessionChainStep | undefined {
  return (outcome.stepIds ?? [])
    .map((id) => chain.steps.find((candidate) => candidate.id === id))
    .find((candidate) => candidate && !chain.outcomeSet!.completedSteps?.includes(candidate.id))
}

export async function sessionOutcomeReviewPlanHold(
  chain: SessionChain,
  outcome: SessionOutcome
): Promise<SessionOutcomeReviewPlanHold | undefined> {
  const step = sessionOutcomeBarrierStep(chain, outcome)
  if (!step || step.kind === 'handoff') {
    return undefined
  }
  const review = step.review
  if (
    review &&
    review.maxRounds > 1 &&
    (review.maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS ||
      Array.from({ length: review.maxRounds - 1 }, (_, index) => index + 1).some(
        (round) =>
          !chain.steps.some(
            (candidate) =>
              candidate.kind !== 'handoff' &&
              candidate.reviewRepair?.groupId === review.groupId &&
              candidate.reviewRepair.afterRound === round
          )
      ))
  ) {
    return {
      kind: 'review-plan',
      groupId: review.groupId,
      code: 'review-plan-invalid',
      reason: 'Repeated review rounds require their authorized repair owner before execution.'
    }
  }
  const repair = step.reviewRepair
  if (!repair) {
    return undefined
  }
  const attempts = chain.outcomeSet!.attempts
  const existing = sessionOutcomeStepAttempt(attempts, step.id)
  if (existing) {
    if (existing.state !== 'completed' || review) {
      return undefined
    }
    const previous = chain.reviewLoop?.groups
      .find((group) => group.id === repair.groupId)
      ?.rounds.find((round) => round.index === repair.afterRound)
    const actual = await sessionOutcomeCandidateVersion(
      chain.workspacePath,
      sessionOutcomeCandidatePaths(outcome, chain)
    )
    return !previous || actual === previous.candidateVersion
      ? {
          kind: 'review-plan',
          groupId: repair.groupId,
          code: 'review-repair-unchanged',
          reason:
            'The repair did not revise the reviewed candidate. Another review round would repeat unchanged work.'
        }
      : undefined
  }
  if (!chain.reviewLoop) {
    return {
      kind: 'review-plan',
      groupId: repair.groupId,
      code: 'review-plan-invalid',
      reason: 'No persisted review findings authorize this repair.'
    }
  }
  const spent =
    !consumeSessionReviewRepair(chain.reviewLoop, repair).consumed &&
    !attempts.some(
      (attempt) =>
        attempt.actionId === sessionOutcomeStepActionId(step.id) && attempt.state === 'retryable'
    )
  return spent
    ? {
        kind: 'review-plan',
        groupId: repair.groupId,
        code: 'review-repair-consumed',
        reason: 'The repair was already consumed; reconcile its launch receipt.'
      }
    : undefined
}
