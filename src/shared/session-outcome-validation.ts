import {
  sessionOutcomeDefinitionSchema,
  type SessionOutcomeDefinition
} from './session-outcome-types'

/**
 * How deep and how wide one outcome may be. The two caps are coupled and measure different things on
 * purpose: the STAGE cap is WIDTH-BLIND — a stage is one hand-off in the plan's depth however many
 * seats run inside it — and the SEAT cap is the width guard. Raising one alone either lets a
 * six-stage plan mint unlimited parallel seats (a chain runs at most eight at a time, and every
 * convergence brief is capped at 100 000 characters), or pushes an author to spread width into depth
 * to get under the stage cap. Change them together.
 */
export const SESSION_OUTCOME_MAX_STAGES = 6
export const SESSION_OUTCOME_MAX_SEATS = 24

/**
 * The compiled runtime steps a cap needs to read. Kept structural so the validator stays free of the
 * chain module: `SessionChainStep[]` satisfies it.
 */
export type SessionOutcomeValidationStep = {
  id: string
  kind?: string
  planVersion?: number
  group?: string
  review?: { round?: number }
  reviewRepair?: { afterRound?: number }
  round?: { index?: number }
}

export type SessionOutcomeValidationContext = {
  /**
   * The chain's compiled steps. Without them the validator cannot tell a wide stage from a deep one
   * — nor a repeated review round from a new seat — so it refuses nothing on size: a cap is an
   * authoring rule, and reading a committed plan back must never lose work.
   */
  steps?: readonly SessionOutcomeValidationStep[]
}

/** A later round of a review, or a repair after one, is the same seat running again, not a new one. */
function isRepeatedRound(step: SessionOutcomeValidationStep): boolean {
  return (
    (step.review?.round ?? 1) > 1 ||
    (step.reviewRepair?.afterRound ?? 1) > 1 ||
    (step.round?.index ?? 1) > 1
  )
}

/** The steps one outcome owns, in plan order, with repeated rounds folded away. */
function outcomeSteps(
  outcome: SessionOutcomeDefinition,
  steps: readonly SessionOutcomeValidationStep[]
): SessionOutcomeValidationStep[] {
  const version = Math.max(
    1,
    ...steps
      .filter((step) => outcome.stepIds?.includes(step.id))
      .map((step) => step.planVersion ?? 1)
  )
  return (outcome.stepIds ?? [])
    .map((stepId) => steps.find((step) => step.id === stepId) ?? { id: stepId })
    .filter((step) => !isRepeatedRound(step) && (step.planVersion ?? 1) === version)
}

/** One stage is one hand-off in the plan's depth: seats that run together count once. */
export function sessionOutcomeStageCount(
  outcome: SessionOutcomeDefinition,
  steps: readonly SessionOutcomeValidationStep[]
): number {
  let stages = 0
  let group: string | undefined
  for (const step of outcomeSteps(outcome, steps)) {
    if (step.group && step.group === group) {
      continue
    }
    group = step.group
    stages += 1
  }
  return stages
}

/** Every agent seat the outcome launches; a person handoff is depth, not a seat. */
export function sessionOutcomeSeatCount(
  outcome: SessionOutcomeDefinition,
  steps: readonly SessionOutcomeValidationStep[]
): number {
  return outcomeSteps(outcome, steps).filter((step) => step.kind !== 'handoff').length
}

export function validateSessionOutcomeDefinitions(
  outcomes: SessionOutcomeDefinition[],
  context?: SessionOutcomeValidationContext
): void {
  if (!outcomes.length || outcomes.length > 64) {
    throw new Error('Define between one and 64 outcomes.')
  }
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  if (byId.size !== outcomes.length) {
    throw new Error('Outcome IDs must be unique.')
  }
  for (const outcome of outcomes) {
    sessionOutcomeDefinitionSchema.parse(outcome)
    const conditions = new Set(outcome.conditions.map((condition) => condition.id))
    if (conditions.size !== outcome.conditions.length) {
      throw new Error('Condition IDs must be unique.')
    }
    if (new Set(outcome.actions.map((action) => action.id)).size !== outcome.actions.length) {
      throw new Error('Action IDs must be unique.')
    }
    if (outcome.actions.some((action) => action.conditionIds.some((key) => !conditions.has(key)))) {
      throw new Error('Action references an unknown condition.')
    }
    if (
      outcome.instructions &&
      !outcome.stepIds?.length &&
      !outcome.actions.some((action) => action.instruction.includes(outcome.instructions!))
    ) {
      throw new Error('Finish instructions must be carried by an executable action.')
    }
    if (context?.steps) {
      if (sessionOutcomeStageCount(outcome, context.steps) > SESSION_OUTCOME_MAX_STAGES) {
        throw new Error(`Choose up to ${SESSION_OUTCOME_MAX_STAGES} stages for one outcome.`)
      }
      if (sessionOutcomeSeatCount(outcome, context.steps) > SESSION_OUTCOME_MAX_SEATS) {
        throw new Error(`Choose up to ${SESSION_OUTCOME_MAX_SEATS} agents for one outcome.`)
      }
    }
    const requiredByFinish: Partial<Record<string, string>> = {
      'my-review': 'review',
      'human-handoff': 'handoff',
      pr: 'pr',
      merge: 'merge',
      deploy: 'deployment'
    }
    const required = requiredByFinish[outcome.finish]
    if (required && !outcome.conditions.some((condition) => condition.kind === required)) {
      throw new Error(`The finish requires a ${required} condition.`)
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new Error('Outcome dependencies contain a cycle.')
    }
    if (visited.has(key)) {
      return
    }
    const outcome = byId.get(key)
    if (!outcome) {
      throw new Error('Outcome dependency does not exist.')
    }
    visiting.add(key)
    outcome.dependsOn.forEach(visit)
    visiting.delete(key)
    visited.add(key)
  }
  outcomes.forEach((outcome) => visit(outcome.id))
}
