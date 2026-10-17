import { useEffect, useState } from 'react'
import { workflowModelClient } from '@/lib/workflow-model-client'
import type { WorkflowOpenRouterModel } from '../../../../../../shared/workflow-openrouter-models'

export type OpenRouterModelCatalog = {
  models: WorkflowOpenRouterModel[]
  /** Model IDs OpenRouter lists now; undefined until the catalog has loaded once. */
  ids?: ReadonlySet<string>
  fetchedAt?: number
  error: boolean
}

const REFRESH_MS = 15 * 60_000
let last: OpenRouterModelCatalog = { models: [], error: false }

// The main process caches for 15 minutes, so opening the menu refetches at most that often.
export function useOpenRouterModelCatalog(): OpenRouterModelCatalog {
  const [catalog, setCatalog] = useState(last)
  useEffect(() => {
    let active = true
    const load = (): void => {
      workflowModelClient
        .models()
        .then((result) => {
          last = {
            models: result.models,
            ids: new Set(result.models.map((model) => model.id)),
            fetchedAt: result.fetchedAt ?? Date.now(),
            error: false
          }
          if (active) {
            setCatalog(last)
          }
        })
        .catch(() => {
          last = { ...last, error: true }
          if (active) {
            setCatalog(last)
          }
        })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
  return catalog
}
