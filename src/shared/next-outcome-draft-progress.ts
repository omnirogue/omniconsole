import type { NextStepOutcomeDraft } from './next-step-draft'
import { openHumanAttentionRequests } from './session-human-attention'
import { effectiveSessionOutcomeBlock } from './session-outcome-block'
import type { SessionOutcome, SessionOutcomeSet } from './session-outcome-types'

type AttentionSet = Pick<SessionOutcomeSet, 'attention' | 'outcomes' | 'attempts'>

/**
 * Only host-derived fields; these never overwrite instructions, agents or finish choices.
 *
 * A blocked outcome is NOT "needs you": it is recovering, waiting or failed, and the phase says
 * which (`next-step-outcome-status.ts`). `needs-you` comes only from a valid open request addressed
 * to the owner about this outcome, and its reason is what that request asks — never the block's
 * diagnostic prose (`docs/reference/session-run-lifecycle.md`).
 */
export function outcomeDraftProgress(
  outcome: Pick<SessionOutcome, 'id' | 'status' | 'evidence' | 'block'>,
  set?: AttentionSet | null,
  planVersion = 1,
  now = Date.now()
): Pick<NextStepOutcomeDraft, 'status' | 'needsYouReason' | 'evidence'> {
  const request =
    set && outcome.status !== 'satisfied'
      ? openHumanAttentionRequests(set, planVersion).find(
          (entry) => entry.recipient.type === 'owner' && entry.scope.outcomeId === outcome.id
        )
      : undefined
  // Why the class travels: a draft shown without its chain has only this to say the stop with.
  const stop = request ? null : effectiveSessionOutcomeBlock(outcome, now)?.class
  return {
    status:
      outcome.status === 'satisfied'
        ? 'complete'
        : request
          ? 'needs-you'
          : stop === 'failed' || stop === 'recovering'
            ? stop
            : 'waiting',
    ...(request ? { needsYouReason: request.ask } : {}),
    evidence: outcome.evidence.map((entry) => entry.receipt)
  }
}
