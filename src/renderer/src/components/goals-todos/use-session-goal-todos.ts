import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { latestSessionTodoList } from '../../../../shared/session-todo-list'
import { goalsTodosTranscriptRef } from './goals-todos-reader'
import { goalsTodosReadRequest, goalsTodosStatusSignature } from './goals-todos-requests'
import { goalsTodosKey } from './goals-todos-rows'
import type { GoalsTodosReadRequest } from './goals-todos-store'
import { sessionGoalTodosView, type SessionGoalTodosView } from './session-goal-todos-view'
import { useGoalsTodosEntry, useGoalsTodosReads } from './use-goals-todos-details'

const NO_REQUESTS: readonly GoalsTodosReadRequest[] = []

/**
 * The goal and to-do list for the session whose info panel is open. While `active`, the
 * session is added to the shared reads (read on open, then again only when its status moves,
 * at most once per 15 s); while closed it asks for nothing and ignores status pings.
 */
export function useSessionGoalTodos(
  session: SidebarSession,
  messages: readonly NativeChatMessage[] | undefined,
  active: boolean
): SessionGoalTodosView {
  const signature = useAppStore((state) =>
    active ? goalsTodosStatusSignature(state, session.paneKey) : undefined
  )
  const request = useMemo(
    () => (active ? goalsTodosReadRequest(session, signature) : null),
    [active, session, signature]
  )
  const requests = useMemo(() => (request ? [request] : NO_REQUESTS), [request])
  useGoalsTodosReads(requests)
  const details = useGoalsTodosEntry(goalsTodosKey(session))
  const fromMessages = useMemo(
    () => (messages ? latestSessionTodoList(messages) : null),
    [messages]
  )
  const canRead = goalsTodosTranscriptRef(session) !== null
  return useMemo(
    () => sessionGoalTodosView({ details, fromMessages, canRead }),
    [details, fromMessages, canRead]
  )
}
