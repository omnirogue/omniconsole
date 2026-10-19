import {
  ownReviewAttention,
  personReviewAttention,
  verificationGateAttention
} from '../../shared/session-attention-drafts'
import {
  lastSessionVerdictReceipt,
  sessionVerdictOfReceipt
} from '../../shared/session-chain-verdict-receipts'
import type { SessionChain } from '../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../shared/session-human-attention'
import type {
  SessionOutcome,
  SessionOutcomeCondition,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import {
  sessionOutcomeGateDecided,
  storedSessionVerdictFindings
} from './session-outcome-gate-hold'
import type { SessionOutcomeHoldReading } from './session-outcome-hold-block'
import { sessionOutcomeReviewVerdictsHold } from './session-outcome-review-hold'
import { sessionOutcomeEventHold } from './session-outcome-event-hold'
import { sessionOutcomeDeliverableRepairHold } from './session-outcome-deliverable-repair-hold'

/** The verifier's own diagnostics that other files compare against; none of them decides a class. */
export const SESSION_OUTCOME_OWN_REVIEW_REQUIRED = 'Your review is required for this version.'
export const SESSION_OUTCOME_AWAITING_EVIDENCE = 'Awaiting verified execution-host evidence.'
/** A verifier that THREW observed nothing, which is different from observing that proof is missing. */
export const SESSION_OUTCOME_VERIFICATION_ERROR = 'Verification failed:'

type Scope = HumanAttentionRequest['scope']

function scopeOf(chain: SessionChain, outcome: SessionOutcome): Scope {
  return {
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    ...(chain.planVersion ? { planVersion: chain.planVersion } : {})
  }
}

/** A gate said no and the plan routes that nowhere: what happens next is the owner's decision. */
export function sessionOutcomeGateFailureHold(
  chain: SessionChain,
  outcome: SessionOutcome,
  stepId: string,
  findings: readonly string[]
): SessionOutcomeHoldReading {
  return {
    block: { class: 'attention', code: 'verification-gate' },
    attention: [
      verificationGateAttention({
        scope: { ...scopeOf(chain, outcome), stepId },
        summary: findings.join(' ').trim() || `${stepId} did not pass`
      })
    ]
  }
}

/**
 * What a gate's last decision means for the outcome it holds, read from the receipt the host
 * persisted — the same reading when the verdict lands, on every later pass and after a restart.
 * A gate that could not judge failed operationally; only a gate that said no is a decision.
 */
export function sessionOutcomeGateVerdictHold(
  chain: SessionChain,
  outcome: SessionOutcome,
  stepId: string
): SessionOutcomeHoldReading | null {
  const receipt = lastSessionVerdictReceipt(chain, stepId)
  const status = sessionVerdictOfReceipt(receipt)?.status
  if (status === 'fail' || status === 'findings') {
    return sessionOutcomeGateFailureHold(
      chain,
      outcome,
      stepId,
      storedSessionVerdictFindings(receipt?.verdict)
    )
  }
  if (status === 'insufficient_evidence') {
    return { block: { class: 'failed', code: 'review-insufficient-evidence' }, attention: [] }
  }
  return null
}

/** A Done When entry a seat decides: what its last decision was says why it is still unproven. */
function reportHold(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  condition: SessionOutcomeCondition
): SessionOutcomeHoldReading {
  const step = chain.steps.find((entry) => entry.id === condition.target)
  const gate = sessionOutcomeGateVerdictHold(chain, outcome, condition.target)
  if (gate) {
    // The owner was asked when this gate stopped the run, and moved the plan on without a pass: the
    // entry stays unproven, and asking again at the finish would be a second request for one failure.
    return gate.attention.length && sessionOutcomeGateDecided(chain, set, outcome, condition.target)
      ? { block: { class: 'failed', code: 'verification-gate' }, attention: [] }
      : gate
  }
  const group =
    step && step.kind !== 'handoff' && step.review
      ? chain.reviewLoop?.groups.find((entry) => entry.id === step.review!.groupId)
      : undefined
  const judged = group?.rounds.find((entry) => entry.index === group.currentRound)
  if (group && judged?.receipts.some((entry) => entry.status !== 'pass')) {
    return sessionOutcomeReviewVerdictsHold(chain, outcome, group)
  }
  return { block: { class: 'failed', code: 'report-unverified' }, attention: [] }
}

function proofHold(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  condition: SessionOutcomeCondition
): SessionOutcomeHoldReading {
  if (condition.kind === 'report') {
    return reportHold(chain, set, outcome, condition)
  }
  if (condition.kind === 'file') {
    // Every stage ran and the file is still not what was promised: its agent is asked to finish it
    // within the repair budget, and after that nothing scheduled will write it.
    return (
      sessionOutcomeDeliverableRepairHold(chain, set, outcome) ?? {
        block: { class: 'failed', code: 'deliverable-unverified' },
        attention: []
      }
    )
  }
  if (condition.kind === 'session') {
    return {
      block: { class: 'waiting', code: 'source-session', wake: 'source session' },
      attention: []
    }
  }
  // A review request, a merge, a delivery, a rollout: proof the world produces and the host polls.
  return { block: { class: 'waiting', code: 'evidence-poll', wake: 'evidence' }, attention: [] }
}

function recipientName(chain: SessionChain, employeeId: string): string | undefined {
  return chain.steps
    .flatMap((step) => (step.kind === 'handoff' ? step.handoff.recipients : []))
    .find((recipient) => recipient.employeeId === employeeId)?.name
}

/**
 * What a finished outcome without its proof is, read from WHICH proof is missing — in the order the
 * verifier asks for it (`session-outcome-verification.ts`): the host's own checks first, then the
 * reviews. The owner's review is a request of the owner; a named person's review is a wait on THEM.
 */
export function sessionOutcomeVerificationHold(
  chain: SessionChain,
  set: SessionOutcomeSet,
  input: SessionOutcome,
  reason: string
): SessionOutcomeHoldReading {
  if (reason.startsWith(SESSION_OUTCOME_VERIFICATION_ERROR)) {
    return { block: { class: 'recovering', code: 'verification-error' }, attention: [] }
  }
  const outcome = set.outcomes.find((entry) => entry.id === input.id) ?? input
  const proven = new Set(
    outcome.evidence
      .filter((entry) => entry.outcomeRevision === outcome.revision)
      .map((entry) => entry.conditionId)
  )
  const unmet = outcome.conditions.filter((condition) => !proven.has(condition.id))
  const events = sessionOutcomeEventHold(chain, outcome, proven)
  // An answer that is not a yes is the owner's decision before anything else; a plain wait on
  // outside events stands only once the host's own proof is in.
  if (
    events &&
    (events.block.class === 'attention' ||
      unmet.every((condition) => condition.kind === 'event' || condition.kind === 'review'))
  ) {
    return events
  }
  const proof = unmet.find((condition) => condition.kind !== 'review')
  if (proof) {
    return proofHold(chain, set, outcome, proof)
  }
  if (!unmet.length) {
    // Proven since the reason was computed: the next pass reads it as satisfied.
    return { block: { class: 'recovering', code: 'verification-pending' }, attention: [] }
  }
  const scope = scopeOf(chain, outcome)
  const attention = unmet.map((condition) =>
    condition.recipientId
      ? personReviewAttention({
          scope: { ...scope, conditionId: condition.id },
          title: outcome.title,
          employeeId: condition.recipientId,
          ...(recipientName(chain, condition.recipientId)
            ? { name: recipientName(chain, condition.recipientId) }
            : {})
        })
      : ownReviewAttention({
          scope: { ...scope, conditionId: condition.id },
          title: outcome.title,
          ...(condition.version ? { version: condition.version } : {})
        })
  )
  if (unmet.some((condition) => !condition.recipientId)) {
    return { block: { class: 'attention', code: 'own-review' }, attention }
  }
  const people = unmet.map(
    (condition) => recipientName(chain, condition.recipientId!) ?? condition.recipientId!
  )
  return {
    block: { class: 'waiting', code: 'person-review', wake: people.join(', ').slice(0, 200) },
    attention
  }
}
