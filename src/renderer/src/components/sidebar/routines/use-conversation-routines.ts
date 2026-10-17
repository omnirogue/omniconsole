import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Automation } from '../../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import {
  getAutomationListTarget,
  listAutomationsForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { openRoutineConversation } from './open-routine-conversation'
import {
  createRoutineCommands,
  routineErrorMessage,
  type RoutineCommands
} from './routine-row-commands'

function useRoutineCatalog(target: AutomationHostTarget) {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [failed, setFailed] = useState(false)
  // Why: the caller memoizes the target per authority, so identity is the refresh trigger.
  useEffect(() => {
    let disposed = false
    let request = 0
    const refresh = async (): Promise<void> => {
      const current = ++request
      try {
        const rows = await listAutomationsForTarget(target)
        if (!disposed && current === request) {
          setAutomations(rows)
          setFailed(false)
        }
      } catch {
        if (!disposed && current === request) {
          setFailed(true)
        }
      }
    }
    setAutomations([])
    setFailed(false)
    void refresh()
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, refresh)
    return () => {
      disposed = true
      window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, refresh)
    }
  }, [target])
  const patch = useCallback((id: string, changes: Partial<Automation>) => {
    setAutomations((rows) => rows.map((row) => (row.id === id ? { ...row, ...changes } : row)))
  }, [])
  const remove = useCallback((id: string) => {
    setAutomations((rows) => rows.filter((row) => row.id !== id))
  }, [])
  return { automations, failed, patch, remove }
}

export type ConversationRoutines = {
  automations: readonly Automation[]
  /** The catalog could not be read; the conversations still list. */
  failed: boolean
  target: AutomationHostTarget
  commands: RoutineCommands
  /** The routine whose conversation or settings are open. */
  selectedId: string | null
  /** The routine whose conversation is being opened. */
  openingId: string | null
  open: (automation: Automation) => void
}

/** The routines of the active authority, as the Conversations list reads and opens them. */
export function useConversationRoutines(): ConversationRoutines {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId)
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedAutomationId = useAppStore((s) => s.setSelectedAutomationId)
  const target = useMemo(
    () => getAutomationListTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const { automations, failed, patch, remove } = useRoutineCatalog(target)
  const commands = useMemo(
    () => createRoutineCommands({ target, patch, remove }),
    [target, patch, remove]
  )
  const openingRequest = useRef(0)
  const [openingId, setOpeningId] = useState<string | null>(null)
  useEffect(() => {
    const requests = openingRequest
    requests.current++
    setOpeningId(null)
    return () => {
      requests.current++
    }
  }, [environmentId])
  const open = useCallback(
    (automation: Automation): void => {
      const request = ++openingRequest.current
      setOpeningId(automation.id)
      setSelectedAutomationId(automation.id)
      void openRoutineConversation(automation, target, () => openingRequest.current === request)
        .catch((error) => {
          if (openingRequest.current !== request) {
            return
          }
          toast.error(
            routineErrorMessage(
              error,
              translate('routines.openFailed', 'Unable to open this routine.')
            ),
            {
              action: {
                label: translate('routines.settings', 'Routine settings'),
                onClick: () => {
                  const state = useAppStore.getState()
                  state.setSelectedAutomationId(automation.id)
                  state.openAutomationsPage()
                }
              }
            }
          )
        })
        .finally(() => {
          if (openingRequest.current === request) {
            setOpeningId(null)
          }
        })
    },
    [setSelectedAutomationId, target]
  )
  return { automations, failed, target, commands, selectedId, openingId, open }
}
