import { useMemo } from 'react'
import type { RoutineSessionOwner } from '@/lib/routine-backed-session'
import { useRoutineConversations, type RoutineConversation } from './routine-conversation-state'
import { routineConversationKey, useRoutineSessionCatalog } from './routine-session-catalog'

function combineRoutineOwners(
  owners: readonly RoutineSessionOwner[],
  legacy: Record<string, RoutineConversation>
): RoutineSessionOwner[] {
  return [
    ...owners.map((owner) => ({
      ...owner,
      legacy: legacy[routineConversationKey(owner.sourceTarget, owner.automation.id)]
    })),
    ...Object.values(legacy).map((entry) => ({ ...entry, legacy: entry }))
  ]
}

/** Non-React read for request handlers that must not route work into a routine's session. */
export function readRoutineOwners(): RoutineSessionOwner[] {
  return combineRoutineOwners(
    useRoutineSessionCatalog.getState().owners,
    useRoutineConversations.getState().byRoutine
  )
}

export function useRoutineOwners() {
  const owners = useRoutineSessionCatalog((state) => state.owners)
  const legacy = useRoutineConversations((state) => state.byRoutine)
  return useMemo(() => combineRoutineOwners(owners, legacy), [owners, legacy])
}
