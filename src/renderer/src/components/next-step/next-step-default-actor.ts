import {
  BUILD_REVIEW_DEFAULT_REVIEWER,
  BUILD_REVIEW_DEFAULT_REVIEWER_COUNT
} from '../../../../shared/build-review-pipeline'
import type { NextStepActor, NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  hostMayRunModel,
  nextReviewerSeat,
  seatModelKey,
  type NextStepSeatAgent
} from './next-step-reviewer-seat'

function actorKey(actor: NextStepActor): string {
  return `${actor.agent}:${actor.model ?? ''}`
}

/**
 * The agent to propose next, with an exact model both engines accept: the next unused
 * codex/claude/grok lineage beside the producer and the reviewers already seated.
 */
export function defaultActor(
  agents: readonly NextStepSeatAgent[],
  previous: NextStepOutcomeStep | undefined,
  reviewers: readonly NextStepActor[] = []
): NextStepActor | null {
  const producer = previous?.kind === 'handoff' ? previous.actor : null
  return nextReviewerSeat(agents, [...(producer ? [producer] : []), ...reviewers])
}

/**
 * A new review starts from Build & Review's default reviewer (Claude · opus · high) when
 * Claude is usable here, its host lists that model, and the producing step is not already
 * that exact actor.
 */
export function defaultReviewer(
  agents: readonly NextStepSeatAgent[],
  previous: NextStepOutcomeStep | undefined
): NextStepActor | null {
  const seed: NextStepActor = {
    agent: BUILD_REVIEW_DEFAULT_REVIEWER.agent as TuiAgent,
    ...(BUILD_REVIEW_DEFAULT_REVIEWER.model ? { model: BUILD_REVIEW_DEFAULT_REVIEWER.model } : {}),
    ...(BUILD_REVIEW_DEFAULT_REVIEWER.effort
      ? { effort: BUILD_REVIEW_DEFAULT_REVIEWER.effort }
      : {})
  }
  const producer = previous?.kind === 'handoff' ? previous.actor : null
  const seedUsable = agents.some(
    (agent) => agent.id === seed.agent && (!seed.model || hostMayRunModel(agent, seed.model))
  )
  return seedUsable && !(producer && actorKey(producer) === actorKey(seed))
    ? seed
    : defaultActor(agents, previous)
}

/** A new review's panel: the default reviewer, then distinct models (other lineages first). */
export function defaultReviewers(
  agents: readonly NextStepSeatAgent[],
  previous: NextStepOutcomeStep | undefined,
  count = BUILD_REVIEW_DEFAULT_REVIEWER_COUNT
): NextStepActor[] {
  const producer = previous?.kind === 'handoff' && previous.actor ? [previous.actor] : []
  const first = defaultReviewer(agents, previous)
  const seats = first ? [first] : []
  while (seats.length < count) {
    const seat = nextReviewerSeat(agents, [...producer, ...seats])
    const taken = [...producer, ...seats].map((actor) => seatModelKey(agents, actor))
    // The proposer's last resort repeats a seated model; a repeat is not another opinion.
    if (!seat || taken.includes(seatModelKey(agents, seat))) {
      break
    }
    seats.push(seat)
  }
  return seats
}
