import type { SidebarSession } from '@/lib/sidebar-sessions'
import { matchesRoutineConversation, routineSessionHost } from '@/lib/routine-backed-session'
import {
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { bindRoutineConversation } from './routine-conversation-binding'
import { useRoutineConversations } from './routine-conversation-state'
import { routineConversationKey } from './routine-session-catalog'
import type { RoutineSessionOwner } from '@/lib/routine-backed-session'

export async function migrateRoutineConversations(
  owners: readonly RoutineSessionOwner[],
  liveSessions: readonly SidebarSession[],
  sourceTarget?: AutomationHostTarget
): Promise<void> {
  if (sourceTarget) {
    for (const [key, entry] of Object.entries(useRoutineConversations.getState().byRoutine)) {
      if (
        getAutomationHostTargetKey(entry.sourceTarget) ===
          getAutomationHostTargetKey(sourceTarget) &&
        !owners.some((owner) => owner.automation.id === entry.automation.id)
      ) {
        useRoutineConversations.getState().unbind(key)
      }
    }
  }
  for (const owner of owners) {
    const key = routineConversationKey(owner.sourceTarget, owner.automation.id)
    const legacy = useRoutineConversations.getState().byRoutine[key]
    if (!legacy) {
      continue
    }
    // A binding whose save failed is newer than the record, so it replaces it.
    if (!owner.automation.conversation || legacy.unsaved) {
      const session = liveSessions.find(
        (row) =>
          row.hostId === routineSessionHost(owner) &&
          !row.unavailable &&
          matchesRoutineConversation(row, legacy)
      )
      if (!session) {
        continue
      }
      await bindRoutineConversation(owner.automation, owner.sourceTarget, {
        tabId: legacy.tabId,
        paneKey: legacy.paneKey,
        sessionKey: session.sessionKey ?? legacy.sessionKey ?? null
      })
    }
    useRoutineConversations.getState().unbind(key)
  }
}
