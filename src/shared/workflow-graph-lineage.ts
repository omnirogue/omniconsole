import { isOllamaModelTag } from './local-ollama-launch'
import { modelLineage } from './model-lineage'
import { openrouterApiId } from './openrouter-route'
import type { WorkflowAgentSpec, WorkflowStep } from './workflow-graph'

export function workflowStepSharesLineage(
  step: WorkflowStep,
  byId: ReadonlyMap<string, WorkflowStep>
): boolean {
  const authors = new Set(
    step.inputs.flatMap(
      (input) =>
        byId.get(input)?.agents.map((agent) => modelLineage(agent.route, agent.model)) ?? []
    )
  )
  const judges = new Set(step.agents.map((agent) => modelLineage(agent.route, agent.model)))
  // Rank excludes self-votes; JEV is independent of every model family.
  return step.kind === 'rank'
    ? new Set([...authors, ...judges]).size === 1 && !step.jev
    : authors.size > 0 && [...judges].every((lineage) => authors.has(lineage))
}

export function workflowAgentModelKnown(agent: WorkflowAgentSpec): boolean {
  if (agent.route !== 'openrouter' && agent.route !== 'ollama') {
    return true
  }
  const named =
    agent.route === 'ollama'
      ? isOllamaModelTag(agent.model)
      : openrouterApiId.safeParse(agent.model).success
  return named && modelLineage(agent.route, agent.model) !== 'unknown'
}
