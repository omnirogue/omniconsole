import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { NextStepActor, NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import type { NextStepTemplateId } from '../../../../shared/next-step-templates'
import { defaultActor } from './next-step-default-actor'
import { newHandoffStep, newReviewStep } from './next-step-outcome-sections'
import { nextReviewerSeat } from './next-step-reviewer-seat'

/**
 * The Add next templates that the outcome model can say with its two step kinds. "Compare
 * answers" is left out: it asks several agents the same question in parallel with their own
 * instructions, which is neither a review (verdicts) nor a sequential handoff.
 */
export const NEXT_STEP_OUTCOME_TEMPLATE_IDS = [
  'research-plan',
  'research-plan-create',
  'council'
] as const satisfies readonly NextStepTemplateId[]

export type NextStepOutcomeTemplateId = (typeof NEXT_STEP_OUTCOME_TEMPLATE_IDS)[number]

/** Up to `count` reviewer seats, each with an exact model and a distinct lineage while one is free. */
function distinctReviewers(
  agents: readonly AgentCatalogEntry[],
  previous: NextStepOutcomeStep | undefined,
  count: number
): NextStepActor[] {
  const producer = previous?.kind === 'handoff' && previous.actor ? [previous.actor] : []
  const seats: NextStepActor[] = []
  while (seats.length < Math.min(count, agents.length)) {
    const seat = nextReviewerSeat(agents, [...producer, ...seats])
    if (!seat) {
      break
    }
    seats.push(seat)
  }
  return seats
}

/** The steps a template appends; null when the host has no agent to run them. */
export function outcomeTemplateSteps(
  id: NextStepOutcomeTemplateId,
  agents: readonly AgentCatalogEntry[],
  previous: NextStepOutcomeStep | undefined
): NextStepOutcomeStep[] | null {
  const actor = defaultActor(agents, previous)
  if (!actor) {
    return null
  }
  switch (id) {
    case 'research-plan':
      return [newHandoffStep(actor, 'research'), newHandoffStep(actor, 'plan')]
    case 'research-plan-create':
      return [
        newHandoffStep(actor, 'research'),
        newHandoffStep(actor, 'plan'),
        newHandoffStep(actor, 'implement')
      ]
    case 'council': {
      const review = newReviewStep(null, 1)
      // Why: the council is several reviewers at once; one agent then combines what they said.
      return [
        { ...review, reviewers: distinctReviewers(agents, previous, 3) },
        newHandoffStep(actor, 'synthesize')
      ]
    }
  }
}

/** How many sequential agents a template would add, for the six-handoff cap. */
export function outcomeTemplateHandoffCount(id: NextStepOutcomeTemplateId): number {
  switch (id) {
    case 'research-plan':
      return 2
    case 'research-plan-create':
      return 3
    case 'council':
      return 1
  }
}
