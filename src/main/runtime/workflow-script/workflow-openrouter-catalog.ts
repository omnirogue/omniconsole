import { openrouterApiId } from '../../../shared/openrouter-route'
import { modelLineage } from '../../../shared/model-lineage'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import type { WorkflowOpenRouterModel } from '../../../shared/workflow-openrouter-models'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

// Short TTL: custom-model pickers refetch on open, so retired models disappear within minutes.
const CATALOG_TTL_MS = 15 * 60_000
let cached: { expires: number; fetchedAt: number; models: WorkflowOpenRouterModel[] } | undefined
let pending: Promise<WorkflowOpenRouterModel[]> | undefined

export async function workflowOpenRouterModels(): Promise<WorkflowOpenRouterModel[]> {
  if (cached && cached.expires > Date.now()) {
    return cached.models
  }
  if (pending) {
    return pending
  }
  pending = (async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      throw new Error('OpenRouter model catalog is unavailable.')
    }
    const value = (await response.json()) as {
      data?: Record<string, unknown>[]
    }
    if (!Array.isArray(value.data)) {
      throw new Error('OpenRouter model catalog is invalid.')
    }
    const models = value.data.flatMap((entry): WorkflowOpenRouterModel[] => {
      if (!openrouterApiId.safeParse(entry.id).success || typeof entry.name !== 'string') {
        return []
      }
      const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
      const pricing = entry.pricing as Record<string, unknown> | undefined
      const promptPrice = Number(pricing?.prompt)
      const completionPrice = Number(pricing?.completion)
      if (![promptPrice, completionPrice].every((price) => Number.isFinite(price) && price >= 0)) {
        return []
      }
      return [
        {
          id: entry.id as string,
          name: entry.name,
          contextLength: Number(entry.context_length) || 0,
          promptPrice,
          completionPrice,
          tools: parameters.includes('tools'),
          structuredOutputs: parameters.includes('structured_outputs')
        }
      ]
    })
    const fetchedAt = Date.now()
    cached = { expires: fetchedAt + CATALOG_TTL_MS, fetchedAt, models }
    return models
  })()
  try {
    return await pending
  } finally {
    pending = undefined
  }
}

export async function workflowOpenRouterModelsSnapshot(): Promise<{
  models: WorkflowOpenRouterModel[]
  fetchedAt: number
}> {
  const models = await workflowOpenRouterModels()
  return { models, fetchedAt: cached?.fetchedAt ?? Date.now() }
}

export async function workflowOpenRouterCatalog(): Promise<LocalWorkflowSeatCatalog['models']> {
  return (await workflowOpenRouterModels())
    .filter((model) => model.structuredOutputs)
    .map((model) => ({
      catalog: {
        id: model.id,
        label: model.name,
        isDefault: false,
        options: []
      },
      resolvedModelId: model.id,
      lineage: modelLineage('openrouter', model.id),
      supportsTools: model.tools
    }))
}
