import { validateSessionOutcomeDefinitions } from './session-outcome-validation'
export {
  SESSION_OUTCOME_MAX_SEATS,
  SESSION_OUTCOME_MAX_STAGES,
  sessionOutcomeSeatCount,
  sessionOutcomeStageCount,
  validateSessionOutcomeDefinitions
} from './session-outcome-validation'
export type {
  SessionOutcomeValidationContext,
  SessionOutcomeValidationStep
} from './session-outcome-validation'
// Writing a set lives next door; every existing importer still finds both of them here.
export { reconcileSessionOutcomeSet, reviseSessionOutcomeSet } from './session-outcome-revise'
import { reconcileSessionOutcomeSet } from './session-outcome-revise'
import {
  readSessionRun,
  type SessionRunPhase,
  type SessionRunReading
} from './session-run-lifecycle'
import type { HumanAttentionRequest } from './session-human-attention'
import {
  sessionOutcomeActionKey,
  sessionOutcomeConditionKey,
  sessionOutcomeDefinition,
  sessionOutcomeSetSchema,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet,
  type SessionOutcomeLifecycle
} from './session-outcome-types'

export function normalizeSessionOutcomeSet(value: unknown): SessionOutcomeSet | null {
  const parsed = sessionOutcomeSetSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  try {
    // Why no steps here: the stage and seat caps are authoring rules and need the compiled steps to
    // read. Reading a committed plan back must never lose it, so a plan that outgrew a cap keeps
    // running and is refused at its next revision, on the write path that has the steps.
    validateSessionOutcomeDefinitions(parsed.data.outcomes.map(sessionOutcomeDefinition))
  } catch {
    return null
  }
  return reconcileSessionOutcomeSet(parsed.data)
}

export function recordSessionOutcomeEvidence(
  set: SessionOutcomeSet,
  evidence: SessionOutcomeEvidence
): SessionOutcomeSet {
  const outcome = set.outcomes.find((entry) => entry.id === evidence.outcomeId)
  const condition = outcome?.conditions.find((entry) => entry.id === evidence.conditionId)
  if (
    !outcome ||
    !condition ||
    evidence.outcomeRevision !== outcome.revision ||
    evidence.conditionKey !== sessionOutcomeConditionKey(condition) ||
    evidence.kind !== condition.kind ||
    evidence.target !== condition.target ||
    (condition.version !== undefined && evidence.version !== condition.version)
  ) {
    throw new Error('Evidence is stale or belongs to a different outcome condition.')
  }
  const activeEvidence = set.outcomes.flatMap((entry) => entry.evidence)
  const existing = [...activeEvidence, ...(set.evidenceHistory ?? [])].find(
    (entry) => entry.id === evidence.id
  )
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(evidence)) {
      throw new Error('Evidence receipt ID conflict.')
    }
    if (activeEvidence.some((entry) => entry.id === evidence.id)) {
      return set
    }
  }
  // A sealed run already holds the receipts that proved it; a later one is about the world since.
  if (set.completion) {
    return set
  }
  return reconcileSessionOutcomeSet({
    ...set,
    outcomes: set.outcomes.map((entry) =>
      entry.id === outcome.id ? { ...entry, evidence: [...entry.evidence, evidence] } : entry
    )
  })
}

/**
 * The coarse progress older callers read. The phase, the requests and the failure all come from
 * `readSessionRun`, the one policy: a blocked reason is a diagnostic here, never "needs you".
 */
export function sessionOutcomeProgress(
  set: SessionOutcomeSet,
  options: { now?: number; planVersion?: number } = {}
): {
  lifecycle: SessionOutcomeLifecycle
  phase: SessionRunPhase
  satisfied: number
  total: number
  reasons: string[]
  attention: HumanAttentionRequest[]
  failure?: SessionRunReading['failure']
  recoveringUntil?: number
  wake?: string
} {
  const run = readSessionRun(set, options)
  return {
    lifecycle: run.lifecycle,
    phase: run.phase,
    satisfied: run.satisfied,
    total: run.total,
    reasons: run.reasons,
    attention: run.attention,
    ...(run.failure ? { failure: run.failure } : {}),
    ...(run.recoveringUntil === undefined ? {} : { recoveringUntil: run.recoveringUntil }),
    ...(run.wake ? { wake: run.wake } : {})
  }
}

export function runnableSessionOutcomeActions(
  set: SessionOutcomeSet
): { outcomeId: string; actionId: string }[] {
  // A sealed run has nothing left to launch, whatever a later writer did to its statuses.
  if (set.completion) {
    return []
  }
  return set.outcomes
    .filter(
      (outcome) =>
        outcome.status !== 'satisfied' &&
        outcome.status !== 'blocked' &&
        outcome.dependsOn.every(
          (id) => set.outcomes.find((entry) => entry.id === id)?.status === 'satisfied'
        )
    )
    .flatMap((outcome) =>
      outcome.actions
        .filter(
          (action) =>
            !set.attempts.some(
              (attempt) =>
                attempt.outcomeId === outcome.id &&
                attempt.actionId === action.id &&
                attempt.state !== 'retryable' &&
                (attempt.state !== 'blocked' ||
                  attempt.actionKey === sessionOutcomeActionKey(action))
            )
        )
        .slice(0, 1)
        .map((action) => ({ outcomeId: outcome.id, actionId: action.id }))
    )
}
