import { useEffect, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { ConsoleWorkflowTemplate } from '../../../../shared/console-workflow-types'

/**
 * Templates for work admitted through the console come from the server. This client
 * never invents them and never substitutes its own local seeds: when the server does
 * not offer them the state is `unavailable`, with the reason it gave.
 */
export type ConsoleWorkflowTemplatesState = {
  state: 'loading' | 'ready' | 'unavailable'
  templates: ConsoleWorkflowTemplate[]
  reason: string | null
}

export function useConsoleWorkflowTemplates(enabled: boolean): ConsoleWorkflowTemplatesState {
  const [result, setResult] = useState<ConsoleWorkflowTemplatesState>({
    state: 'loading',
    templates: [],
    reason: null
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const templates = workflowData(await consoleWorkflowApi().templates())
        if (!cancelled) {
          setResult({ state: 'ready', templates, reason: null })
        }
      } catch (failure) {
        if (!cancelled) {
          setResult({
            state: 'unavailable',
            templates: [],
            reason: workflowErrorMessage(failure)
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])
  return result
}
