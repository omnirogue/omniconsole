import type { SessionOutcomeCondition, SessionOutcomeAction } from './session-outcome-types'

export function sessionOutcomeConditionKey(condition: SessionOutcomeCondition): string {
  return JSON.stringify([
    condition.kind,
    condition.target,
    condition.version ?? null,
    condition.verification ?? null,
    condition.repository ?? null,
    condition.branch ?? null,
    condition.recipientId ?? null,
    ...(condition.recipientSessionId ? [condition.recipientSessionId] : []),
    condition.fileVersions ?? null,
    ...(condition.targetBranch ? [condition.targetBranch] : []),
    // Appended only when present, so every key written before these fields stays the same.
    ...(condition.require ? [{ require: condition.require }] : []),
    ...(condition.event ? [{ event: condition.event }] : [])
  ])
}
export function sessionOutcomeActionKey(action: SessionOutcomeAction): string {
  return JSON.stringify([
    action.id,
    action.instruction,
    action.conditionIds,
    action.agent,
    action.model ?? null,
    action.effort ?? null,
    action.accountChoiceId ?? null,
    ...(action.openrouterCandidates !== undefined ? [action.openrouterCandidates] : []),
    ...(action.route ? [{ route: action.route }] : [])
  ])
}
