import { effortChoicesFor } from '../../../../shared/build-review-model-options'
import { mayIssueVerdict } from '../../../../shared/model-lineage'
import type { BuildReviewAgentChoice } from '../../../../shared/build-review-pipeline'
import type { NextStepActor } from '../../../../shared/next-step-draft'
import { translate } from '@/i18n/i18n'
import {
  hostDefaultModelFor,
  hostModels,
  nextReviewerSeat,
  seatModelKey,
  type NextStepSeatAgent
} from '../next-step/next-step-reviewer-seat'
import type { ReviewerSeat } from './BuildReviewReviewerSettings'
import { choiceUsesSpentModel, type AgentModelUsage } from './build-review-usable-choice'

/**
 * What the selected workspace's host answered about the agents it can run, from the one
 * capability discovery every launch surface uses. `loading` and an empty roster are distinct
 * from a host that answered: neither is evidence that any model is runnable.
 */
export type ReviewerHostCatalog = {
  agents: readonly (NextStepSeatAgent & Omit<AgentModelUsage, 'id' | 'models'>)[]
  loading: boolean
}

function agentLabel(host: ReviewerHostCatalog, choice: BuildReviewAgentChoice): string {
  return host.agents.find((entry) => entry.id === choice.agent)?.label ?? choice.agent
}

function seatLabel(index: number): string {
  return `${translate('buildReview.reviewers.reviewer', 'Reviewer')} ${index + 1}`
}

/** Drops an effort the host's own model does not advertise, so a repin cannot carry a foreign flag. */
function keptEffort(
  choice: BuildReviewAgentChoice,
  agent: NextStepSeatAgent,
  model: string
): string | undefined {
  const models = hostModels(agent) ?? []
  return choice.effort &&
    effortChoicesFor(agent.id, models, model).some((option) => option.value === choice.effort)
    ? choice.effort
    : undefined
}

/**
 * One seat against the host: a model the host lists stays, a proposal it does not list is
 * repinned to the host's own default, and a model the person chose themselves is left alone
 * for `reviewerSeatProblem` to name rather than silently rewritten.
 */
function pinChoice(
  choice: BuildReviewAgentChoice,
  chosen: boolean,
  host: ReviewerHostCatalog,
  taken: readonly NextStepActor[]
): BuildReviewAgentChoice {
  const agent = host.agents.find((entry) => entry.id === choice.agent)
  if (!agent) {
    const proposed = chosen ? null : nextReviewerSeat(host.agents, taken)
    return proposed
      ? { agent: proposed.agent, ...(proposed.model ? { model: proposed.model } : {}) }
      : choice
  }
  const models = hostModels(agent)
  if (!models || (choice.model && models.some((entry) => entry.id === choice.model))) {
    return choice
  }
  // A model the person chose stays for the problem line to name, unless its own usage window
  // is spent: then it could only fail, and the host's next usable model takes the seat.
  if (choice.model && chosen && !choiceUsesSpentModel(choice, agent)) {
    return choice
  }
  const model = hostDefaultModelFor(agent)
  if (!model) {
    return choice
  }
  const effort = keptEffort(choice, agent, model)
  return { agent: choice.agent, model, ...(effort ? { effort } : {}) }
}

/**
 * Whether a reviewer could be its builder's own model: the same agent with the same model, or
 * with either on "Agent default", which the app that starts the run cannot resolve.
 */
export function mayBeBuilderModel(
  builder: BuildReviewAgentChoice,
  reviewer: BuildReviewAgentChoice
): boolean {
  const model = (choice: BuildReviewAgentChoice) => choice.model?.trim().toLowerCase() || null
  const [a, b] = [model(builder), model(reviewer)]
  return builder.agent === reviewer.agent && (!a || !b || a === b)
}

/**
 * A proposed seat that repeats a seated model or may be the builder's moves to another model:
 * of its own agent first, then of a lineage not yet seated, then any; kept only when the host
 * offers nothing else (the caller drops it then).
 */
function distinctChoice(
  choice: BuildReviewAgentChoice,
  host: ReviewerHostCatalog,
  taken: readonly NextStepActor[],
  producer?: BuildReviewAgentChoice
): BuildReviewAgentChoice {
  const keys = new Set(taken.map((actor) => seatModelKey(host.agents, actor)))
  const ok = (candidate: BuildReviewAgentChoice) =>
    mayIssueVerdict(candidate.agent, candidate.model) &&
    !keys.has(seatModelKey(host.agents, candidate as NextStepActor)) &&
    !(producer && mayBeBuilderModel(producer, candidate))
  if (ok(choice)) {
    return choice
  }
  const seated = new Set(taken.map((actor) => actor.agent))
  const candidates = [
    ...host.agents.filter((agent) => agent.id === choice.agent),
    ...host.agents.filter((agent) => agent.id !== choice.agent && !seated.has(agent.id)),
    ...host.agents.filter((agent) => agent.id !== choice.agent && seated.has(agent.id))
  ].flatMap((agent) =>
    (hostModels(agent) ?? []).map((model) => ({
      agent,
      choice: { agent: agent.id, model: model.id }
    }))
  )
  const pick = candidates.find((candidate) => ok(candidate.choice))
  if (!pick) {
    return choice
  }
  const effort =
    pick.agent.id === choice.agent ? keptEffort(choice, pick.agent, pick.choice.model) : undefined
  return { ...pick.choice, ...(effort ? { effort } : {}) }
}

/**
 * Every seat repinned onto the selected host. Seats proposed while discovery was silent are
 * repaired here once it answers, so a seat added during an outage never stays frozen.
 */
export function reconcileReviewerSeats(
  seats: readonly ReviewerSeat[],
  host: ReviewerHostCatalog,
  /** The builder: an unchosen seat never lands on the model it reviews. */
  producer?: BuildReviewAgentChoice
): ReviewerSeat[] {
  if (!host.agents.length) {
    return [...seats]
  }
  const taken: NextStepActor[] = producer ? [producer as NextStepActor] : []
  const kept = seats.flatMap((seat, index) => {
    const pinned = pinChoice(seat.choice, seat.chosen ?? false, host, taken)
    const choice = seat.chosen ? pinned : distinctChoice(pinned, host, taken, producer)
    const key = seatModelKey(host.agents, choice as NextStepActor)
    const keys = taken.map((actor) => seatModelKey(host.agents, actor))
    // A proposal never reviews its own builder, and a default seat is never a repeat: a repeat
    // is not another opinion. A seat the person chose stays for `reviewerSeatProblem` to name.
    if (
      !seat.chosen &&
      ((producer && mayBeBuilderModel(producer, choice)) ||
        (seat.seeded && index > 0 && keys.includes(key)))
    ) {
      return []
    }
    taken.push(choice as NextStepActor)
    // Pinning owns the agent, model and effort; the seat keeps its rubric whatever it lands on.
    const kept =
      seat.choice.rubric && !choice.rubric ? { ...choice, rubric: seat.choice.rubric } : choice
    return [kept === seat.choice ? seat : { ...seat, choice: kept }]
  })
  return kept.length ? kept : seats.slice(0, 1)
}

/**
 * The inline problem that blocks Start, naming exactly what is unverified. Independent seats
 * may share one model — a single-model host is a normal case, not a conflict.
 */
export function reviewerSeatProblem(
  seats: readonly ReviewerSeat[],
  host: ReviewerHostCatalog,
  producer?: BuildReviewAgentChoice
): string | null {
  if (host.loading) {
    return translate(
      'buildReview.reviewers.hostChecking',
      'Checking which models this workspace’s host can run. Start is available once it answers.'
    )
  }
  if (!host.agents.length) {
    return translate(
      'buildReview.reviewers.hostSilent',
      'This workspace’s host has not reported which agents and models it can run, so no reviewer can be verified. Check the host connection, then reopen this dialog.'
    )
  }
  for (const [index, seat] of seats.entries()) {
    const label = seatLabel(index)
    const name = agentLabel(host, seat.choice)
    const agent = host.agents.find((entry) => entry.id === seat.choice.agent)
    if (!agent) {
      return `${label} (${name}) ${translate('buildReview.reviewers.agentUnavailable', 'is not available on this workspace’s host. Choose another agent.')}`
    }
    const models = hostModels(agent)
    if (!models) {
      return `${label} (${name}) ${translate('buildReview.reviewers.modelsUnknown', 'could not be verified: this host has not reported which models it can run. Retry once discovery answers, or choose a model it lists.')}`
    }
    if (!seat.choice.model) {
      return `${label} (${name}) ${translate('buildReview.reviewers.modelMissing', 'has no model this host lists. Choose its model.')}`
    }
    if (!models.some((entry) => entry.id === seat.choice.model)) {
      return `${label} (${name}) ${translate('buildReview.reviewers.modelUnlisted', 'uses a model this host does not list. Choose another model.')}`
    }
    if (producer && mayBeBuilderModel(producer, seat.choice)) {
      return `${label} (${name}) ${translate('buildReview.reviewers.builderModel', 'may be the builder’s own model. Choose another model, or pick the builder’s model explicitly.')}`
    }
  }
  return null
}
