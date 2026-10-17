import { useMemo } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import { useAppStore } from '@/store'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionGoalGroup } from '../../../../shared/session-goal-groups'
import { sessionMissionProgress } from '../../../../shared/session-mission-progress'
import type { SessionGoalTodosView } from './session-goal-todos-view'

/** Reuses the shared first-request cache, chain subscription and already-read PR facts. */
export function useSessionMissionProgress(
  session: SidebarSession,
  view: SessionGoalTodosView,
  chain: SessionChain | null,
  goals: readonly SessionGoalGroup[]
) {
  const key = sidebarSessionStatusKey(session)
  const working = useAppStore((state) =>
    key ? state.agentStatusByPaneKey[key]?.state === 'working' : false
  )
  const activity = useAppStore((state) => {
    const status = key ? state.agentStatusByPaneKey[key] : undefined
    return status?.lastAssistantMessageIsToolOutput ? undefined : status?.lastAssistantMessage
  })
  const prs = useMemo(() => goals.flatMap((goal) => goal.pullRequests), [goals])
  return useMemo(
    () =>
      view.goal?.mission
        ? sessionMissionProgress({
            mission: view.goal.mission,
            outcomes: chain?.outcomeSet,
            pullRequests: prs,
            todos: view.todos,
            working,
            activity,
            planVersion: chain?.planVersion
          })
        : null,
    [view.goal, view.todos, chain?.outcomeSet, chain?.planVersion, prs, working, activity]
  )
}
