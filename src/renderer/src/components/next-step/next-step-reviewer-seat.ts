import { localFallbackProblem } from './local-fallback-selection'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type {
  NextStepActor,
  NextStepOutcomeDraft,
  NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Agents a card-attached plan can admit (exact `agent:model` actors), in seat preference order. */
export const NEXT_STEP_EXACT_MODEL_AGENTS: readonly TuiAgent[] = ['codex', 'claude', 'grok']

export type NextStepSeatAgent = {
  id: TuiAgent
  label?: string
  models?: readonly CatalogModel[]
  /** True when the host itself answered; absent/false means no host answer yet. */
  modelsProbed?: boolean
}

function modelsFor(agent: NextStepSeatAgent): readonly CatalogModel[] {
  return agent.models?.length
    ? agent.models
    : (getAgentSessionOptionCatalog(agent.id)?.models ?? [])
}

/**
 * What the host itself said it can run, or null when it has said nothing yet: missing,
 * still loading, timed out and refused are all unknown, never an empty catalog.
 */
export function hostModels(agent: NextStepSeatAgent): readonly CatalogModel[] | null {
  return agent.models?.length ? agent.models : agent.modelsProbed ? [] : null
}

/** The host's default model for this agent; undefined while the host has not answered. */
export function hostDefaultModelFor(agent: NextStepSeatAgent): string | undefined {
  const models = hostModels(agent)
  return models ? (models.find((model) => model.isDefault) ?? models[0])?.id : undefined
}

export function defaultModelFor(agent: NextStepSeatAgent): string | undefined {
  const models = modelsFor(agent)
  return (models.find((model) => model.isDefault) ?? models[0])?.id
}

/** `agent:model`, reading "Agent default" as the default model it runs, so it is never proposed twice. */
export function seatModelKey(agents: readonly NextStepSeatAgent[], actor: NextStepActor): string {
  const agent = agents.find((entry) => entry.id === actor.agent)
  return `${actor.agent}:${actor.model ?? (agent ? (defaultModelFor(agent) ?? '') : '')}`
}

function seat(agent: NextStepSeatAgent, model: string | undefined): NextStepActor {
  return { agent: agent.id, ...(model ? { model } : {}) }
}

/** Whether the host has not ruled this model out; an unreported catalog is unknown, not a refusal. */
export function hostMayRunModel(agent: NextStepSeatAgent, model: string): boolean {
  const models = hostModels(agent)
  return !models || models.some((entry) => entry.id === model)
}

/**
 * The next seat for a producer and its reviewers: an unused codex/claude/grok lineage at its
 * default model, then an unused exact model of a taken lineage, then a colliding default
 * (independent seat identities still keep it a separate reviewer). Other agents are never
 * proposed because a task-attached plan cannot compile them; null when none is usable.
 */
export function nextReviewerSeat(
  agents: readonly NextStepSeatAgent[],
  taken: readonly NextStepActor[]
): NextStepActor | null {
  const candidates = NEXT_STEP_EXACT_MODEL_AGENTS.flatMap((id) =>
    agents.filter((agent) => agent.id === id)
  )
  const lineages = new Set(taken.map((actor) => actor.agent))
  const exact = new Set(taken.map((actor) => seatModelKey(agents, actor)))
  const fresh = candidates.find((agent) => !lineages.has(agent.id))
  if (fresh) {
    return seat(fresh, defaultModelFor(fresh))
  }
  for (const agent of candidates) {
    const free = modelsFor(agent).find((model) => !exact.has(`${agent.id}:${model.id}`))
    if (free) {
      return seat(agent, free.id)
    }
  }
  return candidates[0] ? seat(candidates[0], defaultModelFor(candidates[0])) : null
}

function describeStep(step: NextStepOutcomeStep, index: number): string {
  return step.kind === 'review' ? `Reviewer ${index + 1}` : 'The handoff agent'
}

/**
 * Before a card-attached save every agent needs an exact model the host itself listed: a
 * "Default" choice is pinned to the host's default here, and anything the host has not
 * verified — an unlisted model, or a catalog it never reported — is named instead of saved.
 */
export function pinOutcomeExactModels(
  outcomes: readonly NextStepOutcomeDraft[],
  agents: readonly NextStepSeatAgent[]
): { outcomes: NextStepOutcomeDraft[]; problem: string | null } {
  let problem: string | null = null
  const pin = (actor: NextStepActor, label: string, handoff = false): NextStepActor => {
    const available = agents.find((agent) => agent.id === actor.agent)
    const name = available?.label ?? actor.agent
    if (
      !NEXT_STEP_EXACT_MODEL_AGENTS.includes(actor.agent) &&
      !(
        handoff &&
        actor.agent === 'omp' &&
        localFallbackProblem(actor, available?.models ?? []) === null
      )
    ) {
      problem ??= `${label} uses ${name}, which a task-attached plan cannot run. Choose Codex, Claude or Grok.`
      return actor
    }
    if (!available) {
      problem ??= actor.model
        ? `${label} (${name}) uses ${actor.model}, which is unavailable on this host. Choose another model.`
        : `${label} (${name}) has no known default model on this host. Choose its model.`
      return actor
    }
    const models = hostModels(available)
    if (!models) {
      problem ??= `${label} (${name}) could not be verified: this host has not reported which models it can run. Retry once discovery answers, or choose a model it lists.`
      return actor
    }
    if (actor.model) {
      if (!models.some((model) => model.id === actor.model)) {
        problem ??= `${label} (${name}) uses ${actor.model}, which is unavailable on this host. Choose another model.`
      }
      return actor
    }
    const model = hostDefaultModelFor(available)
    if (!model) {
      problem ??= `${label} (${name}) has no known default model on this host. Choose its model.`
      return actor
    }
    return { ...actor, model }
  }
  const pinned = outcomes.map((outcome) => ({
    ...outcome,
    steps: outcome.steps.map((step) =>
      step.kind === 'review'
        ? {
            ...step,
            reviewers: step.reviewers.map((reviewer, index) =>
              pin(reviewer, describeStep(step, index))
            )
          }
        : step.actor
          ? { ...step, actor: pin(step.actor, describeStep(step, 0), true) }
          : step
    )
  }))
  return { outcomes: pinned, problem }
}
