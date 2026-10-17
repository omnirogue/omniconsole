import type {
  LocalWorkflowSeatCatalog,
  LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'

export type WorkflowSeatModelChoice = { id: string; label: string; isDefault: boolean }
export type WorkflowSeatModelChoices = Partial<Record<WorkflowRoute, WorkflowSeatModelChoice[]>>

/**
 * The models a graph agent may name, per family, from the account its team seat uses. Families
 * with one model get no picker; OpenRouter has its own.
 */
export function workflowSeatModelChoices(
  catalog: readonly LocalWorkflowSeatCatalog[],
  team: readonly LocalWorkflowSeatChoice[]
): WorkflowSeatModelChoices {
  const choices: WorkflowSeatModelChoices = {}
  for (const seat of team) {
    const entry = catalog.find(
      (candidate) => candidate.agent === seat.agent && candidate.accountId === seat.accountId
    )
    if (seat.agent === 'openrouter' || !entry || entry.models.length < 2) {
      continue
    }
    choices[seat.agent] = entry.models.map(({ catalog: model }) => ({
      id: model.id,
      label: model.label,
      isDefault: model.isDefault === true
    }))
  }
  return choices
}

/** Select options for an agent's model: the offered models, plus a spec-named one not offered. */
export function workflowSeatModelOptions(
  models: readonly WorkflowSeatModelChoice[],
  model: string | undefined
): { value: string; options: { value: string; label: string }[] } {
  const options = models.map((entry) => ({ value: entry.id, label: entry.label }))
  const value = model ?? models.find((entry) => entry.isDefault)?.id ?? ''
  return {
    value,
    options:
      value && !options.some((option) => option.value === value)
        ? [...options, { value, label: value }]
        : options
  }
}
