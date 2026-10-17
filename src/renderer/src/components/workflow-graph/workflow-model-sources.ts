import {
  localWorkflowRouteNamesModel,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'
import {
  localWorkflowModelLabel,
  localWorkflowProviderLabel
} from '../../../../shared/local-workflow-model-label'
import { modelLineage } from '../../../../shared/model-lineage'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import type { WorkflowModelPlanCatalog } from '../../../../shared/workflow-model-plan'
import type { WorkflowPresetModel } from '../../../../shared/workflow-model-presets'
import type { WorkflowModelDefaults } from '../../../../shared/workflow-model-tiers'
import {
  WORKFLOW_OPENROUTER_PRICE_BANDS,
  workflowOpenRouterPriceBand,
  type WorkflowOpenRouterModel
} from '../../../../shared/workflow-openrouter-models'

export type WorkflowModelOption = { id: string; label: string; isDefault: boolean; note?: string }
/**
 * One family this computer can seat and the models it offers. OpenRouter is listed with no
 * models: its catalog is hundreds long, so the picker fetches it when opened.
 */
export type WorkflowModelSource = { route: WorkflowRoute; models: WorkflowModelOption[] }

/** Every family of the team with all its models, including one-model families and Ollama. */
export function workflowModelSources(
  catalog: readonly LocalWorkflowSeatCatalog[],
  team: readonly LocalWorkflowSeatChoice[]
): WorkflowModelSource[] {
  return team.flatMap((seat) => {
    const entry = catalog.find(
      (candidate) => candidate.agent === seat.agent && candidate.accountId === seat.accountId
    )
    if (!entry) {
      return []
    }
    const models =
      seat.agent === 'openrouter'
        ? []
        : entry.models
            // A model whose family cannot be placed can never take a seat.
            .filter((model) => model.lineage !== 'unknown')
            .map(({ catalog: model }) => ({
              id: model.id,
              label: model.label,
              isDefault: model.isDefault === true,
              ...(model.description ? { note: model.description } : {})
            }))
    return [{ route: seat.agent, models }]
  })
}

export function workflowModelDefaults(
  sources: readonly WorkflowModelSource[]
): WorkflowModelDefaults {
  const defaults: WorkflowModelDefaults = {}
  for (const source of sources) {
    const model = source.models.find((entry) => entry.isDefault)
    if (model) {
      defaults[source.route] = model.id
    }
  }
  return defaults
}

/** The name a person reads for a model: its catalog label, or the last part of an opaque id. */
export function workflowModelLabel(
  model: WorkflowPresetModel,
  sources: readonly WorkflowModelSource[]
): string {
  if (localWorkflowRouteNamesModel(model.route)) {
    const id = model.model ?? ''
    return id.slice(id.indexOf('/') + 1) || localWorkflowProviderLabel(model.route)
  }
  const offered = sources.find((source) => source.route === model.route)?.models ?? []
  const match = model.model
    ? offered.find((entry) => entry.id === model.model)
    : offered.find((entry) => entry.isDefault)
  // A family this computer does not seat (a tier may still name it) reads by its usual name.
  return (
    match?.label ??
    (model.model
      ? localWorkflowModelLabel(model.route, model.model)
      : localWorkflowProviderLabel(model.route))
  )
}

/** OpenRouter models a workflow can seat: structured answers, and a family this build knows. */
export function seatableOpenRouterModels(
  models: readonly WorkflowOpenRouterModel[]
): WorkflowOpenRouterModel[] {
  return models.filter(
    (model) => model.structuredOutputs && modelLineage('openrouter', model.id) !== 'unknown'
  )
}

const PLAN_OPENROUTER_LIMIT = 40

/** What the model-plan agent may name: every family's models, Ollama's tags, the cheapest of OpenRouter. */
export function workflowModelPlanCatalog(
  sources: readonly WorkflowModelSource[],
  openrouter: readonly WorkflowOpenRouterModel[]
): WorkflowModelPlanCatalog {
  const band = (model: WorkflowOpenRouterModel) =>
    WORKFLOW_OPENROUTER_PRICE_BANDS.indexOf(workflowOpenRouterPriceBand(model))
  return {
    families: sources
      .filter((source) => !localWorkflowRouteNamesModel(source.route))
      .map((source) => ({ route: source.route, models: source.models })),
    ollama:
      sources.find((source) => source.route === 'ollama')?.models.map((model) => model.id) ?? [],
    openrouter: seatableOpenRouterModels(openrouter)
      .sort((left, right) => band(left) - band(right) || left.promptPrice - right.promptPrice)
      .slice(0, PLAN_OPENROUTER_LIMIT)
      .map(({ id, promptPrice, completionPrice }) => ({ id, promptPrice, completionPrice }))
  }
}
