import type { SessionOutcomeService } from './session-outcome-service'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionChain } from '../../shared/session-chain-types'
import { resolveHumanAttention } from '../../shared/session-human-attention'
import { SESSION_OUTCOME_OWN_REVIEW_REQUIRED } from './session-outcome-verification-hold'

/** Records a user's review approval of a specific immutable result version. */
export async function reviewSessionOutcomeCondition(
  service: SessionOutcomeService,
  id: string,
  expectedRevision: number,
  outcomeId: string,
  conditionId: string,
  version: string,
  now = Date.now()
): Promise<SessionChain> {
  const chain = service.get(id),
    set = chain.outcomeSet!
  // A sealed run is complete and stays complete; approving it again changes nothing.
  if (set.completion) {
    return chain
  }
  await assertSessionOutcomeExecutionScope(service.runtime, chain)
  if (set.revision !== expectedRevision) {
    throw new Error('Outcome revision conflict.')
  }
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)
  if (
    set.continuation.principal &&
    (await readSessionOutcomePrincipal()) !== set.continuation.principal
  ) {
    throw new Error('Restore the original signed company/person before verifying or approving.')
  }
  const condition = outcome?.conditions.find((entry) => entry.id === conditionId)
  if (
    !outcome ||
    condition?.kind !== 'review' ||
    condition.recipientId ||
    !condition.version ||
    version !== condition.version
  ) {
    throw new Error('Review must name the current immutable result version.')
  }
  const refreshed = await verifySessionOutcomeProgress(service.runtime, chain, outcome, true, now)
  const refreshedChain = service.save({ ...chain, outcomeSet: refreshed.set }, expectedRevision)
  const refreshedOutcome = refreshedChain.outcomeSet!.outcomes.find(
    (entry) => entry.id === outcomeId
  )!
  if (
    (refreshed.reason && refreshed.reason !== SESSION_OUTCOME_OWN_REVIEW_REQUIRED) ||
    refreshedOutcome.conditions.find((entry) => entry.id === conditionId)?.version !== version ||
    refreshedOutcome.conditions.some(
      (entry) =>
        entry.kind !== 'review' &&
        !refreshedOutcome.evidence.some((proof) => proof.conditionId === entry.id)
    )
  ) {
    throw new Error(
      refreshed.reason ?? 'The verified result changed. Refresh its version before approving.'
    )
  }
  const approved = recordSessionOutcomeEvidence(
    refreshedChain.outcomeSet!,
    sessionOutcomeVerifiedEvidence(
      refreshedOutcome,
      refreshedOutcome.conditions.find((entry) => entry.id === conditionId)!,
      `user-review:${version}`,
      now,
      version
    )
  )
  // The approval IS the answer: the request that asked for it is met here, by its own source, and
  // not left open until the next pass notices.
  const answered = (approved.attention ?? [])
    .filter(
      (request) =>
        request.state === 'open' &&
        request.source.type === 'review-condition' &&
        request.recipient.type === 'owner' &&
        request.scope.outcomeId === outcomeId &&
        request.scope.conditionId === conditionId
    )
    .reduce(
      (next, request) => resolveHumanAttention(next, request.id, 'Approved by the owner.', now),
      approved
    )
  return service.save({ ...chain, outcomeSet: answered }, expectedRevision)
}
