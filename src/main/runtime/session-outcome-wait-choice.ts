import type { SessionOutcomeService } from './session-outcome-service'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { resolveHumanAttention } from '../../shared/session-human-attention'

export const SESSION_OUTCOME_WAIT_CHOICES = ['keep-waiting', 'continue', 'cancel'] as const
export type SessionOutcomeWaitChoice = (typeof SESSION_OUTCOME_WAIT_CHOICES)[number]

/** The words an agent must find in the owner's own message before it may answer for them. */
const CHOICE_WORDS: Record<SessionOutcomeWaitChoice, RegExp> = {
  'keep-waiting': /\bkeep waiting\b|\bwait (?:longer|more|again)\b/i,
  continue: /\b(?:continue|go ahead|proceed)\b[^.!?\n]{0,40}\b(?:anyway|without)\b/i,
  cancel: /\bcancel\b/i
}

/** Whether an attested owner message states this choice; an agent never picks one on its own. */
export function waitChoiceStated(choice: SessionOutcomeWaitChoice, prompt: string): boolean {
  return CHOICE_WORDS[choice].test(prompt)
}

function answered(set: SessionOutcomeSet, outcomeId: string, conditionId: string, now: number) {
  return (set.attention ?? [])
    .filter(
      (request) =>
        request.state === 'open' &&
        request.recipient.type === 'owner' &&
        request.scope.outcomeId === outcomeId &&
        request.scope.conditionId === conditionId
    )
    .reduce(
      (next, request) => resolveHumanAttention(next, request.id, 'Answered by the owner.', now),
      set
    )
}

/**
 * The owner's answer to a wait that came back as something other than a yes, or ran past its
 * deadline: wait again for a new answer, continue without it, or cancel the rest of the plan.
 */
export type WaitChoiceInput = {
  id: string
  expectedRevision: number
  outcomeId: string
  conditionId: string
  choice: SessionOutcomeWaitChoice
}

export async function chooseSessionOutcomeWait(
  service: SessionOutcomeService,
  { id, expectedRevision, outcomeId, conditionId, choice }: WaitChoiceInput,
  now = Date.now()
): Promise<SessionChain> {
  const chain = service.get(id)
  const set = chain.outcomeSet!
  if (set.completion) {
    return chain
  }
  await assertSessionOutcomeExecutionScope(service.runtime, chain)
  if (set.revision !== expectedRevision) {
    throw new Error('Outcome revision conflict.')
  }
  if (
    set.continuation.principal &&
    (await readSessionOutcomePrincipal()) !== set.continuation.principal
  ) {
    throw new Error('Restore the original signed company/person before answering this wait.')
  }
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)
  const condition = outcome?.conditions.find((entry) => entry.id === conditionId)
  if (!outcome || !condition || !(condition.kind === 'event' || condition.require)) {
    throw new Error('That is not a wait of this plan.')
  }
  if (choice === 'cancel') {
    return service.save(
      { ...chain, state: 'cancelled', outcomeSet: answered(set, outcomeId, conditionId, now) },
      expectedRevision
    )
  }
  if (choice === 'continue') {
    const proven = outcome.evidence.some((entry) => entry.conditionId === conditionId)
    const next = proven
      ? set
      : recordSessionOutcomeEvidence(
          set,
          sessionOutcomeVerifiedEvidence(outcome, condition, `owner-continued:${now}`, now)
        )
    return service.save(
      { ...chain, outcomeSet: answered(next, outcomeId, conditionId, now) },
      expectedRevision
    )
  }
  // Keep waiting: only an answer after now counts, and a passed deadline no longer asks again.
  const rearmed: SessionOutcomeSet = {
    ...set,
    outcomes: set.outcomes.map((entry) =>
      entry.id !== outcomeId
        ? entry
        : {
            ...entry,
            status: entry.status === 'blocked' ? 'pending' : entry.status,
            waits: [
              ...(entry.waits ?? []).filter((fact) => fact.conditionId !== conditionId),
              {
                conditionId,
                status: 'pending' as const,
                checkedAt: now,
                reason: 'Waiting again for a new answer.',
                rearmedAt: now,
                ...(entry.waits?.find((fact) => fact.conditionId === conditionId)?.answerId
                  ? {
                      answerId: entry.waits.find((fact) => fact.conditionId === conditionId)!
                        .answerId
                    }
                  : {})
              }
            ]
          }
    )
  }
  return service.save(
    { ...chain, outcomeSet: answered(rearmed, outcomeId, conditionId, now) },
    expectedRevision
  )
}
