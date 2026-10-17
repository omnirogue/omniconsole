import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { blockOutcome, type OutcomeStepAccess } from './session-outcome-step-progress'

/**
 * WP-3's `consumeSessionOutcomeVerdict(access, chain, outcome, step, attempt)`: reads the verdict a
 * completed seat emitted, spends it once (`select-winner` | `gate` | `record`) and mints the
 * receipts a pass earns. `replayed` means this exact verdict was already spent, which is not a
 * failure; `failed` means the envelope could not be trusted; `reasked` means the seat returned
 * nothing readable and its attempt was given back, so the same seat launches again.
 */
export type SessionOutcomeVerdictConsumer = (
  access: OutcomeStepAccess,
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  attempt: SessionOutcomeAttempt,
  now?: number
) => Promise<'applied' | 'replayed' | 'failed' | 'reasked'>

let consumer: SessionOutcomeVerdictConsumer | null = null

/** Registered once by the verdict package; passing `null` restores the unwired host. */
export function setSessionOutcomeVerdictConsumer(next: SessionOutcomeVerdictConsumer | null): void {
  consumer = next
}

/**
 * The one place the step runner spends a completed seat's verdict. Until the verdict package wires
 * itself in, every completed seat reports `unwired` and the run behaves exactly as it did: a
 * verdict nobody consumed changes nothing, and never silently counts as a pass.
 */
export async function consumeVerdictForStep(
  access: OutcomeStepAccess,
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  attempt: SessionOutcomeAttempt,
  now = Date.now()
): Promise<'applied' | 'replayed' | 'failed' | 'reasked' | 'unwired'> {
  if (!consumer || !step.verdict) {
    return 'unwired'
  }
  const spent = await consumer(access, chain, outcome, step, attempt, now)
  // A consumer that refused with a REASON has already blocked the outcome with it ("this report
  // carries more than one verdict line", "the candidate changed while it was being judged"), and
  // that sentence is the only actionable thing the person gets. Only a refusal that said nothing
  // falls back to the generic one, so the specific words are never overwritten by them.
  const blocked =
    access.read().outcomeSet?.outcomes.find((entry) => entry.id === outcome.id)?.status ===
    'blocked'
  if (spent === 'failed' && !blocked) {
    blockOutcome(
      access,
      outcome.id,
      `The verdict from ${step.id} could not be consumed.`,
      { class: 'failed', code: 'verdict-unconsumed' },
      now
    )
  }
  return spent
}

/**
 * WP-3's `buildSessionVerdictInstructions(step, candidates, outcome)` from
 * `shared/session-chain-verdict-prompt.ts`: the pure suffix that tells a verdict-emitting seat how
 * to end its report so the host can read it. `candidates` are the step ids its verdict ranges over.
 */
export type SessionOutcomeVerdictInstructions = (
  step: SessionChainAgentStep,
  candidates: string[],
  outcome: SessionOutcome,
  /** The immutable candidate version this seat judges, as the host pinned it at launch. */
  candidateVersion?: string
) => string

let instructions: SessionOutcomeVerdictInstructions | null = null

/** Registered once by the verdict package; passing `null` restores the unwired host. */
export function setSessionOutcomeVerdictInstructions(
  next: SessionOutcomeVerdictInstructions | null
): void {
  instructions = next
}

/**
 * The suffix a verdict-emitting seat's brief ends with — for EVERY `verdict` kind, not only the
 * structural review step, so a custom critic prompt still carries the marker the host reads. It is
 * appended to the person's instruction, never replaces it; unwired it adds nothing.
 *
 * `candidateVersion` is the version the host pinned for this seat at launch. The consumer compares
 * the envelope's version against the workspace it reads back, so a seat that was never told which
 * version it judges could not name one the host would accept — a review seat carries its round's
 * pin in `step.review`, every other verdict seat is told here.
 */
export function verdictInstructionsFor(
  step: SessionChainAgentStep,
  outcome: SessionOutcome,
  candidateVersion?: string
): string {
  return instructions && step.verdict
    ? instructions(step, [...step.verdict.over], outcome, candidateVersion)
    : ''
}
