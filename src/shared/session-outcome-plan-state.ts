import type { SessionChain } from './session-chain-types'
import type { SessionOutcome } from './session-outcome-types'

export type SessionOutcomePlanState = 'planning' | 'plan-ready' | null

/**
 * Which plan version this chain is running. `chain.planVersion` is absent on every chain written
 * before WP-0.5 (b), and absent means 1 — reading it in ONE place keeps that guard from being
 * respelled at each caller, where forgetting it would stamp `undefined` into a receipt.
 */
export function sessionOutcomePlanVersion(chain: SessionChain): number {
  return chain.planVersion && chain.planVersion > 0 ? chain.planVersion : 1
}

/** The outcome whose output is a document, if this chain pursues one. */
export function sessionOutcomePlanOutcome(chain: SessionChain): SessionOutcome | null {
  return (
    chain.outcomeSet?.outcomes.find(
      (outcome) => outcome.outputKind === 'plan' || outcome.outputKind === 'mockup'
    ) ?? null
  )
}

/**
 * What the row says about a Plan Mode chain: `planning` while the plan is being written,
 * `plan-ready` once the host holds a receipt for every one of the plan outcome's conditions at its
 * current revision, `null` for ordinary work (and for any chain with no Outcome at all).
 *
 * Why receipts and not `outcome.status` or a finished attempt: settlement is never progress
 * (frozen model §5 invariant 4). A planner that wrote its plan outside the output directory, or
 * wrote a plan.json that fails `work-plan-v1`, leaves the file condition unsatisfied — so the row
 * keeps reading `planning`, which is the truth.
 */
export function sessionOutcomePlanState(chain: SessionChain): SessionOutcomePlanState {
  const outcome = sessionOutcomePlanOutcome(chain)
  if (!outcome) {
    return null
  }
  const proven = outcome.conditions.every((condition) =>
    outcome.evidence.some(
      (entry) =>
        entry.conditionId === condition.id &&
        entry.outcomeId === outcome.id &&
        entry.outcomeRevision === outcome.revision
    )
  )
  return proven ? 'plan-ready' : 'planning'
}
