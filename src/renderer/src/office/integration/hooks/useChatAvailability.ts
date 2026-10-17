// @ts-nocheck
import { translate } from '@/i18n/i18n'
import { useCoreStore } from '../store/coreStore'
import { useActiveTeam } from '../store/teamStore'
import { useUiStore } from '../store/uiStore'

export type ChatAvailability = {
  canChat: boolean
  reason: string
}

/**
 * Derives whether the player can chat with a given agent based on
 * the current project phase and the agent's task state.
 */
export function useChatAvailability(agentIndex: number | null): ChatAvailability {
  const { phase, tasks, isGeneratingAsset } = useCoreStore()
  const agentStatus = useUiStore((s) =>
    agentIndex !== null ? s.agentStatuses[agentIndex] : 'idle'
  )
  const system = useActiveTeam()

  if (agentIndex === null) {
    return { canChat: false, reason: '' }
  }
  if (isGeneratingAsset) {
    return { canChat: false, reason: translate('office.schema.chat.delivering', 'Delivering...') }
  }
  if (phase === 'done') {
    return {
      canChat: false,
      reason: translate('office.schema.chat.projectCompleted', 'Project completed')
    }
  }

  const isLead = agentIndex === system.leadAgent.index

  // 1. Idle Phase: Only Lead Agent can chat (to set the brief)
  if (phase === 'idle') {
    return isLead
      ? { canChat: true, reason: '' }
      : {
          canChat: false,
          reason: translate('office.schema.chat.waitingForBrief', 'Waiting for brief')
        }
  }

  // 2. Working Phase: Lead Agent can always talk. Others only when idle.
  if (isLead || agentStatus === 'idle') {
    return { canChat: true, reason: '' }
  }

  // Provide specific reason for busy agents
  if (agentStatus === 'on_hold') {
    return {
      canChat: false,
      reason: translate('office.schema.chat.reviewRequested', 'Review requested...')
    }
  }

  const activeTask = tasks.find(
    (t) => t.assignedAgentId === agentIndex && t.status === 'in_progress'
  )
  return {
    canChat: false,
    reason: activeTask
      ? translate('office.schema.chat.workingOn', 'Working on: "{{title}}"', {
          title: activeTask.title
        })
      : translate('office.schema.chat.agentBusy', 'Agent is busy')
  }
}
