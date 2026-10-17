import { WORKFLOW_ROUTES, type WorkflowRoute } from './workflow-graph'
import { isWorkflowModelTier } from './workflow-model-tiers'

/**
 * `omni workflow run --models`: which models run which steps, in one flag, so a person or an agent
 * can set it without writing a spec file. Entries are separated by `;`, each `<step>=<models>`:
 *
 *   --models "cheap"                                  every step on the Cheap tier
 *   --models "*=cheap;report=frontier"                 all cheap, the report on Frontier
 *   --models "find=claude:opus,codex,grok,openrouter:deepseek/deepseek-v4-flash,ollama:qwen3:8b"
 *
 * A model is `<route>` (the family's default) or `<route>:<model>`. A list is a combo: the step
 * runs exactly one agent per model. Read into the same plan the describe-the-models agent
 * answers with (workflow-model-plan.ts), so both are applied and checked by one function.
 */
export function workflowModelsFlagPlan(text: string): { steps: Record<string, unknown> } {
  // A Map, so a step named like an Object property ("constructor") is just a step.
  const steps = new Map<string, unknown>()
  for (const part of text.split(';')) {
    const entry = part.trim()
    if (!entry) {
      continue
    }
    const at = entry.indexOf('=')
    const step = at === -1 ? '*' : entry.slice(0, at).trim()
    const value = (at === -1 ? entry : entry.slice(at + 1)).trim()
    if (!step || !value) {
      throw new Error(`"${entry}" is not <step>=<models>.`)
    }
    if (steps.has(step)) {
      throw new Error(`"${step}" is named twice.`)
    }
    if (isWorkflowModelTier(value)) {
      steps.set(step, { tier: value })
      continue
    }
    const agents = value.split(',').map((item) => {
      const model = item.trim()
      if (isWorkflowModelTier(model)) {
        return { tier: model }
      }
      const colon = model.indexOf(':')
      const route = colon === -1 ? model : model.slice(0, colon)
      const named = colon === -1 ? '' : model.slice(colon + 1)
      if (!(WORKFLOW_ROUTES as readonly string[]).includes(route) || (colon !== -1 && !named)) {
        throw new Error(
          `"${model}" is not a tier (cheap, standard, frontier) or <route>[:<model>] with a route of ${WORKFLOW_ROUTES.join(', ')}.`
        )
      }
      return { route: route as WorkflowRoute, ...(named ? { model: named } : {}) }
    })
    // Every step at once keeps each step's own agent count; a named step runs exactly the list.
    steps.set(step, step === '*' ? { agents } : { agents, exact: true })
  }
  if (!steps.size) {
    throw new Error('Name a tier or <step>=<models>.')
  }
  return { steps: Object.fromEntries(steps) }
}
