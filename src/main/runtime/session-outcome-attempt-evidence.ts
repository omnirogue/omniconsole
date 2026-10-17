import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomePlanVersion } from '../../shared/session-outcome-plan-state'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionOutcomeAttempt, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  sessionOutcomeVerifiedEvidence,
  verifySessionOutcomeCondition
} from './session-outcome-evidence'

/**
 * The first rung of the recovery ladder: completion evidence that already exists wins. A worker
 * that wrote its result and then stalled, crashed or was cut off a moment before reporting did the
 * work, so its proven action is settled `completed` instead of being run a second time.
 *
 * A step attempt has no action of its own — its conditions are the whole outcome's, which an
 * earlier stage may already have proven — so only an outcome's own actions settle here.
 */
export async function settleProvenSessionOutcomeAttempt(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  initial: SessionOutcomeSet,
  attempt: SessionOutcomeAttempt,
  now: number
): Promise<{ set: SessionOutcomeSet; settled: boolean }> {
  let set = initial
  const outcome = set.outcomes.find((entry) => entry.id === attempt.outcomeId)
  const action = outcome?.actions.find((entry) => entry.id === attempt.actionId)
  if (!outcome || !action) {
    return { set, settled: false }
  }
  const proofs = outcome.conditions.filter(
    (entry) => action.conditionIds.includes(entry.id) && entry.kind !== 'review'
  )
  for (const condition of proofs) {
    if (
      set.outcomes
        .find((entry) => entry.id === outcome.id)!
        .evidence.some((entry) => entry.conditionId === condition.id)
    ) {
      continue
    }
    // A proof that cannot be read is simply not proof yet; it must not fail the pass it runs in.
    const verified = await verifySessionOutcomeCondition(
      condition,
      chain.workspacePath,
      runtime,
      { ...chain, outcomeSet: set },
      outcome.id
    ).catch(() => ({ verified: false as const }))
    if (verified.verified) {
      set = recordSessionOutcomeEvidence(
        set,
        // `producedUnder`: a receipt names the plan version that earned it, so v1's proof stays
        // readable beside v2's.
        sessionOutcomeVerifiedEvidence(
          outcome,
          condition,
          verified.receipt,
          now,
          verified.version,
          sessionOutcomePlanVersion(chain)
        )
      )
    }
  }
  const current = set.outcomes.find((entry) => entry.id === outcome.id)!
  if (
    !action.conditionIds.every((id) => current.evidence.some((entry) => entry.conditionId === id))
  ) {
    return { set, settled: false }
  }
  return {
    settled: true,
    set: {
      ...set,
      attempts: set.attempts.map((entry) =>
        entry.id === attempt.id
          ? {
              ...entry,
              state: 'completed',
              error: undefined,
              failure: undefined,
              awaiting: undefined,
              updatedAt: now
            }
          : entry
      )
    }
  }
}
