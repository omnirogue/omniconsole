import { sessionOutcomeDefinition, type SessionOutcomeDefinition } from './session-outcome-types'

/**
 * What an outcome IS, as opposed to how it is pursued: the desired state and the Done When contract.
 * Two commits whose identities match are the same outcome, so the revision stands and every receipt
 * keeps its meaning; a change here is what makes evidence stale.
 *
 * `finish` is NOT identity. Who receives the work once it is done — hand it back for feedback,
 * carry on, pass it to a person — is strategy, and strategy belongs to the plan: choosing a
 * different reader does not make the work unproven. It still shows up as a change whenever it
 * brings one with it, because a finish that needs a review or a handoff needs that condition in the
 * Done When list, and the conditions ARE identity.
 *
 * Derived from `sessionOutcomeDefinition()` so a field added to the definition counts as identity
 * until someone decides otherwise.
 */
export function sessionOutcomeIdentity(outcome: SessionOutcomeDefinition): SessionOutcomeIdentity {
  const {
    stepIds: _stepIds,
    actions: _actions,
    finish: _finish,
    ...identity
  } = sessionOutcomeDefinition(outcome)
  return identity
}
export type SessionOutcomeIdentity = Omit<
  SessionOutcomeDefinition,
  'stepIds' | 'actions' | 'finish'
>

/**
 * The action id the host mints for one step's attempt. The spelling is the host's (`step_<id>`,
 * `session-outcome-steps.ts:93`); naming it here lets the revision rules ask "does this step have an
 * attempt?" without re-inventing it.
 */
export function sessionOutcomeStepActionId(stepId: string): string {
  return `step_${stepId}`
}

/**
 * The step one action id names, or null when the action is not a step's. The inverse of the line
 * above, in the same file, so the spelling has one owner: the executor has to ask WHICH step it is
 * about to run — a `same-session` step continues a conversation instead of starting a worker — and
 * it only ever receives the action.
 */
export function sessionOutcomeActionStepId(actionId: string): string | null {
  return actionId.startsWith('step_') ? actionId.slice('step_'.length) || null : null
}
