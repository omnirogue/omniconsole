import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { fallbackConversationTitle } from '@/lib/conversation-state'
import { useMinuteTick } from '@/lib/conversation-retention'
import { isRoutineBackedSession } from '@/lib/routine-backed-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useRoutineOwners } from '@/components/sidebar/routines/use-routine-owners'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import {
  goalsTodosInputFor,
  goalsTodosReadRequest,
  selectGoalsTodosStatusSignatures
} from './goals-todos-requests'
import {
  buildGoalsTodosGroups,
  selectGoalsTodosInputs,
  type GoalsTodosGroups,
  type GoalsTodosInput
} from './goals-todos-rows'
import type { GoalsTodosReadRequest } from './goals-todos-store'
import { useGoalsTodosDetails } from './use-goals-todos-details'

function isUnnamed(session: SidebarSession): boolean {
  const label = session.label.trim()
  return label === session.agent || label === fallbackConversationTitle(session.agent)
}

/**
 * The bounded set of sessions worth reading (everything still going, then the newest finished
 * ones from the last week, at most 100) and their read requests. The view and the
 * Conversations list both use this, so the shared scheduler sees the same set from each.
 */
export function useGoalsTodosInputs(
  observed: readonly SidebarSession[],
  now: number
): { inputs: GoalsTodosInput[]; requests: GoalsTodosReadRequest[] } {
  const routineOwners = useRoutineOwners()
  const signatures = useAppStore(useShallow(selectGoalsTodosStatusSignatures))
  const inputs = useMemo(() => {
    const sessions = observed.filter((session) => !isRoutineBackedSession(session, routineOwners))
    return selectGoalsTodosInputs(
      sessions.map((session) =>
        goalsTodosInputFor(session, session.paneKey ? signatures[session.paneKey] : undefined)
      ),
      now
    )
  }, [observed, routineOwners, signatures, now])
  const requests = useMemo(() => {
    const list: GoalsTodosReadRequest[] = []
    for (const input of inputs) {
      const paneKey = input.session.paneKey
      const request = goalsTodosReadRequest(
        input.session,
        paneKey ? signatures[paneKey] : undefined
      )
      if (request) {
        list.push(request)
      }
    }
    return list
  }, [inputs, signatures])
  return { inputs, requests }
}

/**
 * Every recent session's goal and to-do list, grouped by whether it needs the person. Built
 * only from state the app already holds plus read-only transcript reads; see the reader.
 */
export function useGoalsTodos(): { groups: GoalsTodosGroups; now: number } {
  const now = useMinuteTick()
  const observed = useSidebarSessions()
  const { inputs, requests } = useGoalsTodosInputs(observed, now)
  const details = useGoalsTodosDetails(requests)
  const groups = useMemo(
    () => buildGoalsTodosGroups({ inputs, details, isUnnamed }),
    [inputs, details]
  )
  return { groups, now }
}
