import { reviewFindingsAttention } from '../../shared/session-attention-drafts'
import { sessionReviewBlockCause } from '../../shared/session-chain-review'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import type { SessionOutcomeHoldReading } from './session-outcome-hold-block'

type ReviewGroup = NonNullable<SessionChain['reviewLoop']>['groups'][number]

/**
 * What the verdicts of a judged round mean for the outcome they hold. A missing verdict and a
 * verifier that could not judge are operational failures; only findings the authorized rounds did
 * not resolve are a decision, and only that one asks a person.
 */
export function sessionOutcomeReviewVerdictsHold(
  chain: SessionChain,
  outcome: SessionOutcome,
  group: ReviewGroup
): SessionOutcomeHoldReading {
  const round = group.rounds.find((entry) => entry.index === group.currentRound)
  const cause = sessionReviewBlockCause(round?.receipts ?? [])
  if (cause === 'no-verdict') {
    return { block: { class: 'failed', code: 'reviewer-no-verdict' }, attention: [] }
  }
  if (cause === 'insufficient-evidence') {
    return { block: { class: 'failed', code: 'review-insufficient-evidence' }, attention: [] }
  }
  const seat = chain.steps.find(
    (step) =>
      step.kind !== 'handoff' &&
      step.review?.groupId === group.id &&
      step.review.round === group.currentRound
  )
  return {
    block: { class: 'attention', code: 'review-findings' },
    attention: [
      reviewFindingsAttention({
        scope: {
          outcomeId: outcome.id,
          outcomeRevision: outcome.revision,
          ...(chain.planVersion ? { planVersion: chain.planVersion } : {}),
          ...(seat ? { stepId: seat.id } : {})
        },
        rounds: group.currentRound,
        findings: round!.receipts.reduce(
          (total, receipt) => total + receipt.blockingFindings.length,
          0
        )
      })
    ]
  }
}

/**
 * What a stopped review round is, read from the round the host persisted — so the tick that blocks
 * it and every later recompute (or a restart) classify it the same way. The step runner also holds
 * a group whose round was never judged as blocked: a plan with no repair owner for its rounds, a
 * repair that changed nothing. Those are honest failures of the plan or the repairer, never a
 * question, and asking the same seats again would not change them.
 */
export function sessionOutcomeReviewRoundHold(
  chain: SessionChain,
  outcome: SessionOutcome,
  groupId: string
): SessionOutcomeHoldReading {
  const group = chain.reviewLoop?.groups.find((entry) => entry.id === groupId)
  if (group?.status === 'blocked') {
    return sessionOutcomeReviewVerdictsHold(chain, outcome, group)
  }
  return {
    block: {
      class: 'failed',
      code: group?.status === 'repairing' ? 'review-repair-unchanged' : 'review-plan-invalid'
    },
    attention: []
  }
}
