import type { SidebarSession } from '@/lib/sidebar-sessions'
import { matchesRoutineConversation, routineSessionHost } from '@/lib/routine-backed-session'
import { useRoutineSessionCatalog } from './routine-session-catalog'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Automation } from '../../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../../shared/automation-owner-ref'
import type { AutomationHostTarget } from '@/components/automations/automation-host-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

export type RoutineConversation = {
  automation: Automation
  sourceTarget: AutomationHostTarget
  hostId?: ExecutionHostId
  ownerRef?: AutomationOwnerRef | null
  tabId: string
  paneKey: string | null
  sessionKey?: string | null
  /** A binding whose save failed; the next catalog sync saves it again. */
  unsaved?: boolean
}

// Bindings are scoped to the catalog authority and validated against restored sessions.
export const useRoutineConversations = create<{
  byRoutine: Record<string, RoutineConversation>
  stash: (key: string, entry: RoutineConversation) => void
  unbind: (key: string) => void
  reconcile: (
    liveSessions: readonly SidebarSession[],
    authoritativeHosts?: readonly string[]
  ) => void
}>()(
  persist(
    (set) => ({
      byRoutine: {},
      stash: (key, entry) => set((state) => ({ byRoutine: { ...state.byRoutine, [key]: entry } })),
      unbind: (key) =>
        set((state) => ({
          byRoutine: Object.fromEntries(
            Object.entries(state.byRoutine).filter(([id]) => id !== key)
          )
        })),
      reconcile: (liveSessions, authoritativeHosts) =>
        set((state) => ({
          byRoutine: Object.fromEntries(
            Object.entries(state.byRoutine).filter(
              ([, entry]) =>
                (authoritativeHosts !== undefined &&
                  !authoritativeHosts.includes(routineSessionHost(entry) ?? '')) ||
                liveSessions.some(
                  (session) =>
                    session.hostId === routineSessionHost(entry) &&
                    matchesRoutineConversation(session, entry)
                )
            )
          )
        }))
    }),
    { name: 'routine-conversations-v1' }
  )
)

export function useRoutineForTab(tabId: string, paneKey: string) {
  return useRoutineSessionCatalog((state) => {
    const owner = state.owners.find((entry) => {
      const binding = entry.automation.conversation
      return binding?.tabId === tabId && (!binding.paneKey || binding.paneKey === paneKey)
    })
    return owner
  })
}
