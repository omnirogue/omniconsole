import type { HumanAttentionDraft } from '../../shared/session-human-attention'
import type { SessionOutcomeBlockInput } from '../../shared/session-outcome-block'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  decideSessionOutcomeHandoffRecovery,
  SESSION_OUTCOME_HANDOFF_SIGN_IN
} from './session-outcome-handoff-recovery'
import type { SessionOutcomeGateHold } from './session-outcome-gate-hold'
import { sessionOutcomeReviewRoundHold } from './session-outcome-review-hold'
import type { SessionOutcomeReviewPlanHold } from './session-outcome-review-plan-hold'
import {
  sessionOutcomeGateVerdictHold,
  sessionOutcomeVerificationHold
} from './session-outcome-verification-hold'

/**
 * A hold on an outcome that is not a stopped attempt: a handoff that did not go out, a review round
 * that stopped or whose plan cannot run, a gate that said no with nowhere to route it, a finished
 * outcome whose proof is not there yet. The status recompute names the hold; this says what class
 * of block it is and which requests (if any) it asks of a person.
 */
export type SessionOutcomeHold =
  | { kind: 'handoff'; stepId: string; reason: string }
  | { kind: 'review-round'; groupId: string; reason: string }
  | SessionOutcomeReviewPlanHold
  | SessionOutcomeGateHold
  | { kind: 'verification'; reason: string }

export type SessionOutcomeHoldReading = {
  block: SessionOutcomeBlockInput
  /** Requests to open for this hold; the recompute opens them and lists their ids on the block. */
  attention: HumanAttentionDraft[]
}

function handoffHold(
  chain: SessionChain,
  hold: Extract<SessionOutcomeHold, { kind: 'handoff' }>,
  now: number
): SessionOutcomeHoldReading {
  const step = chain.steps.find((entry) => entry.id === hold.stepId)
  const recovery =
    step?.kind === 'handoff'
      ? decideSessionOutcomeHandoffRecovery(step.handoff, now)
      : ({ kind: 'fail', code: 'handoff-step-missing' } as const)
  if (recovery.kind === 'fail') {
    return { block: { class: 'failed', code: recovery.code }, attention: [] }
  }
  if (recovery.kind === 'wait') {
    return {
      block: { class: 'recovering', code: recovery.code, until: recovery.until },
      attention: []
    }
  }
  if (recovery.kind === 'resend') {
    const code = recovery.rekey ? 'handoff-rejected' : 'handoff-unconfirmed'
    return { block: { class: 'recovering', code, until: now }, attention: [] }
  }
  // Nothing failed: the sender stopped before it sent anything.
  if (hold.reason === SESSION_OUTCOME_HANDOFF_SIGN_IN) {
    // No request: nothing holds this between passes, so one opened here would be closed as met by
    // the next recompute and announced again by the next send. A changed principal is the tick's.
    return { block: { class: 'failed', code: 'handoff-sign-in' }, attention: [] }
  }
  // The files the handoff names are not there yet: the capture is asked again every tick.
  return {
    block: { class: 'waiting', code: 'handoff-deliverables', wake: 'deliverables' },
    attention: []
  }
}

export function sessionOutcomeHoldBlock(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  hold: SessionOutcomeHold,
  now: number
): SessionOutcomeHoldReading {
  if (hold.kind === 'handoff') {
    return handoffHold(chain, hold, now)
  }
  if (hold.kind === 'review-round') {
    return sessionOutcomeReviewRoundHold(chain, outcome, hold.groupId)
  }
  if (hold.kind === 'review-plan') {
    // The plan or its repairer failed before any round was judged: nobody can answer that.
    return { block: { class: 'failed', code: hold.code }, attention: [] }
  }
  if (hold.kind === 'gate') {
    return (
      sessionOutcomeGateVerdictHold(chain, outcome, hold.stepId) ?? {
        block: { class: 'failed', code: 'verification-gate' },
        attention: []
      }
    )
  }
  return sessionOutcomeVerificationHold(chain, set, outcome, hold.reason)
}
