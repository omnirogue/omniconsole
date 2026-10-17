import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import { conversationFleetScope } from '@/store/conversation-fleet-store'
import type { ConsoleConversationFleetInventory } from '../../../../shared/console-conversation-fleet-types'
import type { NextStepLoad } from '../next-step/use-next-step-recipients'

export type FleetInventoryReader = {
  inventory: NextStepLoad<ConsoleConversationFleetInventory>
  /** Reads the inventory again and refuses a reply that outlived its signed-in person. */
  refresh: () => Promise<ConsoleConversationFleetInventory>
  reload: () => void
}

/**
 * The one read of the fleet inventory every fleet surface shares — the 🚀 popover, the
 * dispatch panel and the Machines view. A reply that arrives after the signed-in person
 * or the request generation changed is thrown away rather than shown.
 */
export function useFleetInventory(): FleetInventoryReader {
  const [inventory, setInventory] = useState<NextStepLoad<ConsoleConversationFleetInventory>>({
    phase: 'loading'
  })
  const generation = useRef(0)
  const current = useRef(true)
  // Why: the selector returns the scope string, never an object (React #185).
  const scope = useAppStore(() => conversationFleetScope())
  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current
    const requestScope = conversationFleetScope()
    try {
      const result = workflowData(await consoleWorkflowApi().fleetInventory())
      if (
        !current.current ||
        requestScope !== conversationFleetScope() ||
        requestGeneration !== generation.current
      ) {
        throw new Error('The fleet selection changed. Refresh and choose again.')
      }
      setInventory({ phase: 'ready', value: result })
      return result
    } catch (error) {
      if (
        current.current &&
        requestScope === conversationFleetScope() &&
        requestGeneration === generation.current
      ) {
        setInventory({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
  }, [])
  useEffect(() => {
    current.current = true
    setInventory({ phase: 'loading' })
    void refresh().catch(() => undefined)
    return () => {
      current.current = false
      generation.current += 1
    }
  }, [scope, refresh])
  const reload = useCallback(() => {
    void refresh().catch(() => undefined)
  }, [refresh])
  return { inventory, refresh, reload }
}
