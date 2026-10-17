import type { AutomationOwnerRef } from '../../../shared/automation-owner-ref'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { AutomationConversation } from '../../../shared/automation-conversation'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { AutomationHostTarget } from '@/components/automations/automation-host-client'
import type { SidebarSession } from './sidebar-sessions'

export type RoutineSessionOwner = {
  hostId?: ExecutionHostId
  ownerRef?: AutomationOwnerRef | null
  automation: Automation
  sourceTarget: AutomationHostTarget
  runs?: readonly AutomationRun[]
  legacy?: AutomationConversation | null
}

export function routineSessionHost(owner: RoutineSessionOwner) {
  if (owner.hostId) {
    return owner.hostId
  }
  return owner.sourceTarget.kind === 'environment'
    ? toRuntimeExecutionHostId(owner.sourceTarget.environmentId)
    : owner.automation.executionTargetType === 'ssh'
      ? toSshExecutionHostId(owner.automation.executionTargetId)
      : 'local'
}

export function matchesRoutineConversation(
  session: Pick<SidebarSession, 'tabId' | 'paneKey' | 'sessionKey'>,
  binding?: AutomationConversation | null
): boolean {
  return Boolean(
    binding &&
    ((binding.sessionKey && binding.sessionKey === session.sessionKey) ||
      (binding.tabId === session.tabId &&
        (!binding.paneKey || binding.paneKey === session.paneKey)))
  )
}

/** Ownership always includes the execution host: tab ids alone are not globally unique. */
export function isRoutineBackedSession(
  session: SidebarSession,
  automations: readonly RoutineSessionOwner[]
): boolean {
  return automations.some((owner) => {
    if (session.hostId !== routineSessionHost(owner)) {
      return false
    }
    if (
      matchesRoutineConversation(session, owner.automation.conversation) ||
      matchesRoutineConversation(session, owner.legacy)
    ) {
      return true
    }
    return (
      owner.runs?.some((run) =>
        Boolean(
          (run.terminalPaneKey && run.terminalPaneKey === session.paneKey) ||
          (run.terminalSessionId && run.terminalSessionId === session.tabId) ||
          (run.chatSessionId &&
            session.sessionKey ===
              JSON.stringify([session.hostId, 'structured', run.chatSessionId]))
        )
      ) ?? false
    )
  })
}
