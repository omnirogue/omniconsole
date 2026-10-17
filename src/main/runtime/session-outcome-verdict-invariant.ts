import { verdictInvariantProblems } from '../../shared/session-chain-verdict-receipts'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { blockSessionOutcomes } from './session-outcome-hold-write'

/**
 * The receipt may still land — a replayed tick records the one a crash lost — so the host keeps
 * looking; a block nothing clears goes stale and reads as failed by itself. Never a request.
 */
export const VERDICT_RECEIPT_MISSING_BLOCK = {
  class: 'recovering',
  code: 'verdict-receipt-missing'
} as const

/**
 * The runtime invariant on the tick (arch v5 §3): `completedSteps ∩ verdictSteps ⊆ verdicts.stepId`.
 *
 * A verdict seat that reached `completedSteps` without a persisted receipt decided nothing, so
 * everything downstream of it — the seats its winner enabled, the Done When entries a gate would
 * have minted — is unproven. The outcome that owns that seat blocks with the invariant's own words
 * instead of advancing, and a satisfied outcome is blocked too: a receipt-less verdict under a
 * `satisfied` row is precisely the false pass this exists to catch.
 *
 * Returns `null` when the invariant holds, so the tick writes nothing on the ordinary path. The
 * problems are computed per outcome, over that outcome's own steps, so one violated plan never
 * blocks its siblings with a reason that names a step they do not contain.
 */
export function blockOutcomesWithoutVerdictReceipt(
  chain: SessionChain,
  set: SessionOutcomeSet,
  now = Date.now()
): SessionOutcomeSet | null {
  // A sealed run is proven; nothing observed afterwards is about it any more.
  if (set.completion) {
    return null
  }
  const reasons = new Map<string, string>()
  for (const outcome of set.outcomes) {
    const ids = new Set(outcome.stepIds ?? [])
    const problems = verdictInvariantProblems({
      steps: chain.steps.filter((step) => ids.has(step.id)),
      outcomeSet: set,
      ...(chain.verdicts ? { verdicts: chain.verdicts } : {})
    })
    if (problems.length) {
      reasons.set(outcome.id, problems.join(' '))
    }
  }
  let blocked = set
  for (const [outcomeId, reason] of reasons) {
    blocked = blockSessionOutcomes(
      blocked,
      (outcome) => outcome.id === outcomeId,
      reason,
      VERDICT_RECEIPT_MISSING_BLOCK,
      now
    )
  }
  return reasons.size ? blocked : null
}
