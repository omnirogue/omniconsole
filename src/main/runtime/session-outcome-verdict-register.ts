import {
  buildSessionVerdictInstructions,
  type SessionVerdictCandidate
} from '../../shared/session-chain-verdict-prompt'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { consumeSessionOutcomeVerdict } from './session-outcome-verdict'
import {
  setSessionOutcomeVerdictConsumer,
  setSessionOutcomeVerdictInstructions
} from './session-outcome-verdict-hook'

/**
 * What a verdict seat is asked to judge, by the ids the host will compare its envelope against.
 *
 * A gate ranges over DONE WHEN ids, not over steps: listing them as candidates would tell a
 * verifier to judge "done_1" as if it were a report it had read, so the gate's `over` is rendered
 * as the done-when block and its candidate list is empty. Every other kind ranges over the seats it
 * read, which are exactly the labelled `=== <stepId> ===` excerpts in the same brief.
 */
function verdictCandidates(
  step: SessionChainAgentStep,
  over: readonly string[]
): SessionVerdictCandidate[] {
  return step.verdict?.consumed === 'gate' ? [] : over.map((stepId) => ({ stepId }))
}

/**
 * Wire WP-3's verdict package into the host: the consumer the completed-attempt arm spends a
 * verdict through, and the marker suffix every verdict-emitting seat's brief ends with. Registered
 * once where the outcome service is constructed, so a judge, critique or verify seat that finishes
 * is read by the host instead of leaving its decision in prose nobody consumes.
 *
 * Idempotent on purpose: a second host in the same process (the tests build several) registers the
 * same two functions.
 */
export function registerSessionOutcomeVerdictHandling(): void {
  setSessionOutcomeVerdictConsumer(consumeSessionOutcomeVerdict)
  setSessionOutcomeVerdictInstructions(
    (
      step: SessionChainAgentStep,
      candidates: string[],
      outcome: SessionOutcome,
      version?: string
    ) =>
      buildSessionVerdictInstructions(step, verdictCandidates(step, candidates), {
        title: outcome.title,
        doneWhen: outcome.conditions.map((condition) => ({
          id: condition.id,
          ...(condition.label ? { label: condition.label } : {})
        })),
        ...(version ? { candidateVersion: version } : {})
      })
  )
}
