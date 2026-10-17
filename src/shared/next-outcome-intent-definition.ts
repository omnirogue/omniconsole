import { sessionFinishChoiceSchema, assertSessionFinishIntent } from './session-finish-intent'
import { assertNextOutcomeIntentEvidence } from './next-outcome-intent-evidence'
import { z } from 'zod'
import {
  sessionOutcomeDefinitionSchema,
  type SessionOutcomeDefinition
} from './session-outcome-types'
import { validateSessionOutcomeDefinitions } from './session-outcome-state'
import { nextOutcomeIntent } from './next-outcome-intent'
import { nextOutcomeTeamPlanSchema } from './next-outcome-team-plan-schema'
import {
  nextOutcomeReviewPlanSchema,
  validateNextOutcomeReviewPlans
} from './next-outcome-review-plan'

export const nextOutcomeIntentSubmissionSchema = z
  .object({
    sessionFinish: sessionFinishChoiceSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
    sourcePrompt: z.string().min(1).max(256_000),
    outcomes: z.array(sessionOutcomeDefinitionSchema).min(1).max(64),
    team: nextOutcomeTeamPlanSchema.optional(),
    reviewPlans: z.array(nextOutcomeReviewPlanSchema).min(1).max(32).optional()
  })
  .strict()

export type NextOutcomeIntentSubmission = z.infer<typeof nextOutcomeIntentSubmissionSchema>

/**
 * A wait is a precondition, but an outcome's conditions are checked after its actions run: an action
 * beside a wait would start before the wait cleared. So the wait stands alone and the step after it
 * depends on it.
 */
function assertWaitsStandAlone(outcomes: readonly SessionOutcomeDefinition[]): void {
  const mixed = outcomes.find(
    (outcome) =>
      outcome.conditions.some((condition) => condition.kind === 'event') &&
      (outcome.actions.length > 0 || Boolean(outcome.stepIds?.length))
  )
  if (mixed) {
    throw new Error(
      `Outcome ${mixed.id} mixes a wait with work: put the wait in its own outcome with actions: [], and the next step in an outcome that dependsOn it (route "same-session").`
    )
  }
}

/**
 * Outcomes that are only the person's own words delivered later: behind a wait, every action
 * continuing the same conversation. That is the person sending "then merge" once the wait clears,
 * to the agent they would have told anyway — not a worker claiming a publication it cannot prove.
 */
function deferredConversationTurns(outcomes: readonly SessionOutcomeDefinition[]): Set<string> {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  const waits = (id: string, seen = new Set<string>()): boolean => {
    const outcome = byId.get(id)
    if (!outcome || seen.has(id)) {
      return false
    }
    seen.add(id)
    return (
      outcome.conditions.some(
        (condition) =>
          condition.kind === 'event' || (condition.kind === 'review' && condition.require)
      ) || outcome.dependsOn.some((dep) => waits(dep, seen))
    )
  }
  return new Set(
    outcomes
      .filter(
        (outcome) =>
          outcome.actions.length > 0 &&
          outcome.actions.every((action) => action.route === 'same-session') &&
          outcome.conditions.every((condition) => condition.kind === 'session') &&
          outcome.dependsOn.some((dep) => waits(dep))
      )
      .map((outcome) => outcome.id)
  )
}

export function validateNextOutcomeIntentSubmission(
  value: unknown,
  source: {
    prompt: string
    expectedRevision: number
    outcomes: readonly SessionOutcomeDefinition[]
  }
): NextOutcomeIntentSubmission {
  const submission = nextOutcomeIntentSubmissionSchema.parse(value)
  if (
    submission.expectedRevision !== source.expectedRevision ||
    submission.sourcePrompt !== source.prompt
  ) {
    throw new Error(
      'Source prompt or outcome revision changed. Read outcome context again before binding.'
    )
  }
  if (submission.sessionFinish) {
    assertSessionFinishIntent(submission.sessionFinish, source.prompt)
  }
  validateSessionOutcomeDefinitions(submission.outcomes)
  validateNextOutcomeReviewPlans({
    plans: submission.reviewPlans ?? [],
    outcomes: submission.outcomes,
    prompt: source.prompt,
    priorOutcomes: source.outcomes
  })
  const ids = new Set(submission.outcomes.map((outcome) => outcome.id))
  if (source.outcomes.some((outcome) => !ids.has(outcome.id))) {
    throw new Error(
      'The source agent cannot silently remove a committed obligation. Keep every existing outcome ID; scope removal requires the user editor.'
    )
  }
  assertWaitsStandAlone(submission.outcomes)
  const deferred = deferredConversationTurns(submission.outcomes)
  for (const outcome of submission.outcomes) {
    const intent = nextOutcomeIntent(outcome.instructions ?? outcome.title)
    for (const instruction of deferred.has(outcome.id)
      ? []
      : [
          outcome.instructions ?? outcome.title,
          ...outcome.actions.map((action) => action.instruction)
        ]) {
      assertNextOutcomeIntentEvidence(instruction, outcome.conditions)
    }
    if (
      intent.kind === 'files' &&
      intent.targets.some(
        (target) =>
          !outcome.conditions.some(
            (condition) => condition.kind === 'file' && condition.target === target
          )
      )
    ) {
      throw new Error(
        'Every explicit file destination must remain a condition with its exact path.'
      )
    }
  }
  return submission
}
