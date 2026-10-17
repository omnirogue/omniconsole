import {
  sessionOutcomeConditionKey,
  sessionOutcomeActionKey,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import { validateNextOutcomeIntentSubmission } from '../../shared/next-outcome-intent-definition'
import { nextOutcomeIntent } from '../../shared/next-outcome-intent'
import { nextOutcomeEscalationEvidenced } from '../../shared/next-outcome-intent-evidence'
import type { ResolvedNextOutcomeHandoff } from '../../shared/next-outcome-handoff-request'
import type { ResolvedNextOutcomeWait } from '../../shared/next-outcome-wait-request'
import { isDirectSourceInstructionQuote } from '../../shared/source-instruction-evidence'

export function sessionOutcomeQuotedInstruction(instruction: string, authority?: string): boolean {
  return Boolean(
    authority &&
    instruction.trim().length >= 12 &&
    isDirectSourceInstructionQuote(instruction, authority)
  )
}

export function assertSessionOutcomeInferredConditions(
  input: SessionOutcomeCommit,
  old: SessionChain | undefined,
  authorityInstruction?: string,
  handoffs: readonly ResolvedNextOutcomeHandoff[] = [],
  waits: readonly ResolvedNextOutcomeWait[] = []
): void {
  if (input.source !== 'ai') {
    return
  }
  if (!authorityInstruction || input.expectedSourcePrompt !== authorityInstruction) {
    throw new Error(
      'The attested source prompt changed. Read outcome context again before committing.'
    )
  }
  validateNextOutcomeIntentSubmission(
    {
      expectedRevision: input.expectedRevision,
      sourcePrompt: input.expectedSourcePrompt,
      outcomes: input.outcomes,
      ...(input.sessionFinish ? { sessionFinish: input.sessionFinish } : {}),
      ...(input.reviewPlans ? { reviewPlans: input.reviewPlans } : {})
    },
    {
      prompt: authorityInstruction,
      expectedRevision: old?.outcomeSet?.revision ?? 0,
      outcomes: old?.outcomeSet?.outcomes ?? []
    }
  )
  for (const prior of old?.outcomeSet?.outcomes ?? []) {
    const next = input.outcomes.find((outcome) => outcome.id === prior.id)
    if (
      !next ||
      next.finish !== prior.finish ||
      next.instructions !== prior.instructions ||
      prior.dependsOn.some((id) => !next.dependsOn.includes(id)) ||
      (prior.stepIds ?? []).some((id) => !next.stepIds?.includes(id)) ||
      prior.conditions.some(
        (condition) =>
          !next.conditions.some(
            (entry) =>
              entry.id === condition.id &&
              sessionOutcomeConditionKey(entry) === sessionOutcomeConditionKey(condition)
          )
      ) ||
      prior.actions.some(
        (action) =>
          !next.actions.some(
            (entry) => sessionOutcomeActionKey(entry) === sessionOutcomeActionKey(action)
          )
      )
    ) {
      throw new Error(
        'AI cannot weaken a committed outcome: retain its finish, instructions, conditions, dependencies, steps, and authorized actions. Scope changes require the directing user route.'
      )
    }
  }
  for (const outcome of input.outcomes) {
    // Why: a condition key matching some OTHER outcome's prior condition is not this outcome's authority;
    // an AI could otherwise clone a user-bound merge/handoff condition onto a new outcome of its own.
    const priorOutcome = old?.outcomeSet?.outcomes.find((prior) => prior.id === outcome.id)
    for (const condition of outcome.conditions) {
      const retained = priorOutcome?.conditions.some(
        (allowed) => sessionOutcomeConditionKey(allowed) === sessionOutcomeConditionKey(condition)
      )
      if (condition.verification && !retained) {
        throw new Error(
          'A new executable verifier requires an explicit user-authored outcome condition.'
        )
      }
      // Why: the host merges, deploys and hands off on its own once bound; only the prompt can ask for that.
      if (
        !retained &&
        !nextOutcomeEscalationEvidenced(condition, authorityInstruction, handoffs, waits)
      ) {
        throw new Error(
          condition.kind === 'event'
            ? `The attested source prompt does not ask for this ${condition.event?.source ?? ''} wait: name the person, the channel and what counts (approve or reply) the way the person said it, and file only waits \`outcome context\` returned.`
            : `The attested source prompt does not ask for a ${condition.kind} finish; the user adds it in Next.`
        )
      }
    }
    for (const action of outcome.actions) {
      const intent = nextOutcomeIntent(action.instruction)
      if (
        intent.kind === 'unsupported' &&
        outcome.conditions.every((condition) =>
          ['file', 'review', 'report'].includes(condition.kind)
        )
      ) {
        throw new Error(intent.reason)
      }
    }
  }
}
