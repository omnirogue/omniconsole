import { settleRoutineBindingWrites } from './routine-binding-writes'
import { routineConversationHost } from './routine-conversation-host'
import type { Automation } from '../../../../../shared/automations-types'
import { useAppStore } from '@/store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { isRoutineBackedSession } from '@/lib/routine-backed-session'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import {
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { useRoutineConversations } from './routine-conversation-state'
import { routineConversationKey, useRoutineSessionCatalog } from './routine-session-catalog'

export async function closeRoutineConversations(
  automation: Automation,
  sourceTarget: AutomationHostTarget
): Promise<void> {
  const key = routineConversationKey(sourceTarget, automation.id)
  const runs = await listAutomationRunsForTarget(sourceTarget, automation.id)
  const legacy = useRoutineConversations.getState().byRoutine[key]
  const owner = {
    automation,
    sourceTarget,
    runs,
    legacy,
    hostId: routineConversationHost(automation, sourceTarget)
  }
  const tabs = new Set(
    buildSidebarSessions(useAppStore.getState())
      .filter((session) => isRoutineBackedSession(session, [owner]))
      .flatMap((session) => (session.tabId ? [session.tabId] : []))
  )
  for (const tabId of tabs) {
    await new Promise<void>((resolve, reject) =>
      closeTerminalTab(tabId, {
        reason: 'user',
        captureRecentlyClosed: false,
        force: true,
        skipRunningProcessConfirm: true,
        onClosed: resolve,
        onCancel: () => reject(new Error('The routine conversation could not be closed.'))
      })
    )
  }
  await settleRoutineBindingWrites(key)
}

export function forgetRoutineConversations(
  automation: Automation,
  sourceTarget: AutomationHostTarget
): void {
  useRoutineConversations.getState().unbind(routineConversationKey(sourceTarget, automation.id))
  useRoutineSessionCatalog.getState().remove(sourceTarget, automation.id)
}
