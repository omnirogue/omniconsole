import type { SessionChain } from '../../shared/session-chain-types'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { holdSessionOutcome } from './session-outcome-hold-write'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { isSealedOutcomeChain } from './session-outcome-source-uniqueness'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import type { SessionOutcomeService } from './session-outcome-service'

/** A person asked for one condition to be verified now. Call it inside the chain's lane. */
export async function verifySessionOutcomeOnRequest(
  service: SessionOutcomeService,
  id: string,
  expectedRevision: number,
  outcomeId: string,
  conditionId: string
): Promise<SessionChain> {
  const chain = service.get(id),
    set = chain.outcomeSet!
  // Sealed success is not re-examined: drift after the seal is about some later run.
  if (isSealedOutcomeChain(chain)) {
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
  if (!outcome || !condition) {
    throw new Error('Unknown outcome condition.')
  }
  const verified = await verifySessionOutcomeProgress(service.runtime, chain, outcome, true)
  // A failed gate is classified by the hold seam, which also says whether it asks a person anything.
  const next = verified.reason
    ? holdSessionOutcome(
        chain,
        verified.set,
        outcome.id,
        { kind: 'verification', reason: verified.reason },
        service.now()
      )
    : verified.set
  const saved = service.save({ ...chain, outcomeSet: next }, expectedRevision)
  if (verified.reason) {
    throw new Error(verified.reason)
  }
  return saved
}
