import { writeRoutineBinding } from './routine-binding-writes'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Automation } from '../../../../../shared/automations-types'
import type { AutomationConversation } from '../../../../../shared/automation-conversation'
import {
  updateAutomationForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import { useRoutineConversations } from './routine-conversation-state'
import { routineConversationKey, useRoutineSessionCatalog } from './routine-session-catalog'

export async function bindRoutineConversation(
  automation: Automation,
  sourceTarget: AutomationHostTarget,
  conversation: AutomationConversation,
  hostId?: ExecutionHostId
): Promise<void> {
  const catalog = useRoutineSessionCatalog.getState()
  const key = routineConversationKey(sourceTarget, automation.id)
  const previous = catalog.owners.find(
    (row) => routineConversationKey(row.sourceTarget, row.automation.id) === key
  )
  // Retain the launched identity even if persistence fails, so retry cannot launch a duplicate.
  catalog.put({
    ...previous,
    ...(hostId ? { hostId } : {}),
    automation: { ...automation, conversation },
    sourceTarget
  })
  let saved: Automation
  try {
    saved = await writeRoutineBinding(key, () =>
      updateAutomationForTarget(automation, { conversation }, sourceTarget)
    )
  } catch (error) {
    // Why: the catalog's next refresh restores the unbound record, so the chat would
    // reappear as an ordinary conversation and the next open would launch a second one.
    const current = useRoutineSessionCatalog
      .getState()
      .owners.find((row) => routineConversationKey(row.sourceTarget, row.automation.id) === key)
    if (current?.automation.conversation === conversation) {
      useRoutineConversations.getState().stash(key, {
        automation,
        sourceTarget,
        hostId: current.hostId,
        ...conversation,
        unsaved: true
      })
    }
    throw error
  }
  const current = useRoutineSessionCatalog
    .getState()
    .owners.find((row) => routineConversationKey(row.sourceTarget, row.automation.id) === key)
  if (current?.automation.conversation === conversation) {
    useRoutineSessionCatalog.getState().put({ ...current, automation: saved })
  }
  useRoutineConversations.getState().unbind(key)
  emitAutomationsChangedWindowEvent(
    sourceTarget.kind === 'environment' ? { environmentId: sourceTarget.environmentId } : {}
  )
}
