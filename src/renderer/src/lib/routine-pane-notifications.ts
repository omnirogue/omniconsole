import { buildSidebarSessions } from './sidebar-sessions'
import { isRoutineBackedSession } from './routine-backed-session'
import { useAppStore } from '@/store'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import { useRoutineConversations } from '@/components/sidebar/routines/routine-conversation-state'
export function routineOwnsPaneNotification(paneKey: string): boolean {
  const owners = [
    ...useRoutineSessionCatalog.getState().owners,
    ...Object.values(useRoutineConversations.getState().byRoutine).map((entry) => ({
      ...entry,
      legacy: entry
    }))
  ]
  if (!owners.length) {
    return false
  }
  const session = buildSidebarSessions(useAppStore.getState()).find(
    (row) => row.paneKey === paneKey
  )
  return Boolean(session && isRoutineBackedSession(session, owners))
}
