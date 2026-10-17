import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { effortChoicesFor } from '../../../../shared/build-review-model-options'
import type { BuildReviewAgentChoice } from '../../../../shared/build-review-pipeline'

/** What the host's usage says about one agent's models, as the capability roster carries it. */
export type AgentModelUsage = {
  id: string
  models?: readonly CatalogModel[]
  unavailableModels?: readonly CatalogModel[]
  defaultModelUnavailable?: boolean
}

/** Whether this choice would start a model a spent window rules out. */
export function choiceUsesSpentModel(
  choice: BuildReviewAgentChoice,
  agent: AgentModelUsage | undefined
): boolean {
  if (!agent) {
    return false
  }
  return choice.model
    ? Boolean(agent.unavailableModels?.some((model) => model.id === choice.model))
    : Boolean(agent.defaultModelUnavailable)
}

/**
 * The choice a setup launches, derived and never stored: "Agent default" while the agent's own
 * default is spent, or a model a spent window rules out, becomes the next usable model. Why
 * derived: the reading changes under an open setup, and a stored repin would outlive it.
 */
export function usableAgentChoice(
  choice: BuildReviewAgentChoice,
  agents: readonly AgentModelUsage[]
): BuildReviewAgentChoice {
  const agent = agents.find((entry) => entry.id === choice.agent)
  const models = agent?.models ?? []
  const next = models.find((model) => model.isDefault) ?? models[0]
  if (!next || !choiceUsesSpentModel(choice, agent)) {
    return choice
  }
  const effort =
    choice.effort &&
    effortChoicesFor(choice.agent, models, next.id).some((option) => option.value === choice.effort)
      ? choice.effort
      : undefined
  return { agent: choice.agent, model: next.id, ...(effort ? { effort } : {}) }
}
