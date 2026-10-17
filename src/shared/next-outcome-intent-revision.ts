import type { NextStepOutcomeDraft } from './next-step-draft'
import type { SessionOutcomeDefinition } from './session-outcome-types'
import { sessionOutcomeDefinition } from './session-outcome-types'

export type NextOutcomeCommittedContext = {
  definitions: readonly SessionOutcomeDefinition[]
  drafts: readonly NextStepOutcomeDraft[]
}

export function retainedNextOutcomeDefinition(
  outcome: NextStepOutcomeDraft,
  committed: NextOutcomeCommittedContext | undefined,
  stepIds: string[]
): SessionOutcomeDefinition | undefined {
  const prior = committed?.definitions.find((entry) => entry.id === outcome.id)
  const draft = committed?.drafts.find((entry) => entry.id === outcome.id)
  if (
    !prior ||
    !draft ||
    outcome.instructions !== draft.instructions ||
    JSON.stringify(outcome.finish) !== JSON.stringify(draft.finish)
  ) {
    return undefined
  }
  if (
    prior.conditions.some(
      (condition) => condition.kind === 'report' && !stepIds.includes(condition.target)
    )
  ) {
    return undefined
  }
  return { ...sessionOutcomeDefinition(prior), stepIds }
}
