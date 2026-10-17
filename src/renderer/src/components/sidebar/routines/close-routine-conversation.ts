import { writeRoutineBinding } from './routine-binding-writes'
import { routineSessionHost } from '@/lib/routine-backed-session'
import { updateAutomationForTarget } from '@/components/automations/automation-host-client'
import { useRoutineConversations } from './routine-conversation-state'
import { routineConversationKey, useRoutineSessionCatalog } from './routine-session-catalog'

/** Called only after host-confirmed chat close completion; closing a chat never deletes its schedule. */
export async function unbindClosedRoutineConversation(
  tabId: string,
  hostId?: string | null
): Promise<void> {
  const legacy = useRoutineConversations.getState()
  for (const [key, entry] of Object.entries(legacy.byRoutine)) {
    if (entry.tabId === tabId && (!hostId || routineSessionHost(entry) === hostId)) {
      legacy.unbind(key)
    }
  }
  for (const owner of useRoutineSessionCatalog.getState().owners) {
    if (
      owner.automation.conversation?.tabId !== tabId ||
      (hostId && routineSessionHost(owner) !== hostId)
    ) {
      continue
    }
    const key = routineConversationKey(owner.sourceTarget, owner.automation.id)
    useRoutineSessionCatalog
      .getState()
      .put({ ...owner, automation: { ...owner.automation, conversation: null } })
    await writeRoutineBinding(key, async () => {
      const saved = await updateAutomationForTarget(
        owner.automation,
        { conversation: null },
        owner.sourceTarget
      )
      const current = useRoutineSessionCatalog
        .getState()
        .owners.find((row) => routineConversationKey(row.sourceTarget, row.automation.id) === key)
      if (current && !current.automation.conversation) {
        useRoutineSessionCatalog.getState().put({ ...current, automation: saved })
      }
    })
  }
}

export function routineConversationClosed(tabId: string, hostId?: string | null): void {
  void unbindClosedRoutineConversation(tabId, hostId).catch((error) => {
    console.warn('Could not clear closed routine conversation', error)
  })
}
