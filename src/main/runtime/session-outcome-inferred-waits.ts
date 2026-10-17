import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import {
  nextOutcomeWaitRequests,
  resolveNextOutcomeWaits,
  type ResolvedNextOutcomeWait
} from '../../shared/next-outcome-wait-request'
import { readSessionOutcomeHandoffPeople } from './session-outcome-handoff'
import { isNewInferredPersonCondition } from './session-outcome-inferred-handoff'

/** The waits the attested prompt asks for, people resolved against the signed-in roster. */
export async function readInferredSessionWaits(prompt: string): Promise<{
  waits: ResolvedNextOutcomeWait[]
  principal?: string
}> {
  const requests = nextOutcomeWaitRequests(prompt)
  if (!requests.some((request) => request.people.length)) {
    return { waits: resolveNextOutcomeWaits(prompt, []) }
  }
  const { principal, people } = await readSessionOutcomeHandoffPeople()
  return { principal, waits: resolveNextOutcomeWaits(prompt, people) }
}

/** A wait's person is shown by the roster's name for them, never by a name an agent wrote. */
export function stampSessionWaitPeople(
  input: SessionOutcomeCommit,
  waits: readonly ResolvedNextOutcomeWait[]
): SessionOutcomeCommit {
  const names = new Map(
    waits.flatMap((wait) => wait.persons).map((person) => [person.id, person.name])
  )
  return {
    ...input,
    outcomes: input.outcomes.map((outcome) => ({
      ...outcome,
      conditions: outcome.conditions.map((condition) => {
        const event = condition.event
        if (condition.kind !== 'event' || !event?.personId) {
          return condition
        }
        const name = names.get(event.personId)?.slice(0, 80)
        const { personName: _typed, ...rest } = event
        return { ...condition, event: name ? { ...rest, personName: name } : rest }
      })
    }))
  }
}

/**
 * A chat-filed person review that other work waits behind releases it only on an approval: "needs
 * changes" is the owner's decision (keep waiting, continue anyway, cancel), never an early start.
 */
export function requireApprovalBeforeDependents(
  input: SessionOutcomeCommit,
  old: SessionChain | undefined
): SessionOutcomeCommit {
  const gating = new Set(input.outcomes.flatMap((outcome) => outcome.dependsOn))
  return {
    ...input,
    outcomes: input.outcomes.map((outcome) =>
      gating.has(outcome.id)
        ? {
            ...outcome,
            conditions: outcome.conditions.map((condition) =>
              condition.kind === 'review' &&
              condition.recipientId &&
              !condition.require &&
              isNewInferredPersonCondition(condition, outcome.id, old)
                ? { ...condition, require: 'approve' as const }
                : condition
            )
          }
        : outcome
    )
  }
}

/**
 * What an agent-filed commit may carry for waits: the prompt's waits resolved against the roster,
 * each wait's person named by the roster, and approve-only reviews wherever later work waits.
 */
export async function prepareInferredSessionWaits(
  input: SessionOutcomeCommit,
  old: SessionChain | undefined,
  prompt: string | undefined
): Promise<{ input: SessionOutcomeCommit; waits: ResolvedNextOutcomeWait[]; principal?: string }> {
  if (input.source !== 'ai') {
    return { input, waits: [] }
  }
  const added = input.outcomes.some((outcome) =>
    outcome.conditions.some(
      (condition) =>
        condition.kind === 'event' &&
        !old?.outcomeSet?.outcomes
          .find((prior) => prior.id === outcome.id)
          ?.conditions.some(
            (prior) => sessionOutcomeConditionKey(prior) === sessionOutcomeConditionKey(condition)
          )
    )
  )
  const read = added ? await readInferredSessionWaits(prompt ?? '') : { waits: [] }
  return {
    ...read,
    input: requireApprovalBeforeDependents(stampSessionWaitPeople(input, read.waits), old)
  }
}
