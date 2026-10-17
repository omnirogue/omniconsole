import { useEffect, useState } from 'react'
import { workflowModelClient } from '@/lib/workflow-model-client'
import type { WorkflowOpenRouterModel } from '../../../../shared/workflow-openrouter-models'

/** OpenRouter's live catalog, asked for only while something that shows it is open. */
export function useWorkflowOpenRouterModels(enabled: boolean): {
  models: WorkflowOpenRouterModel[]
  failed: boolean
} {
  const [models, setModels] = useState<WorkflowOpenRouterModel[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let active = true
    void (async () => {
      try {
        const result = await workflowModelClient.models()
        if (active) {
          setModels(result.models)
          setFailed(false)
        }
      } catch {
        if (active) {
          setFailed(true)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [enabled])
  return { models, failed }
}
