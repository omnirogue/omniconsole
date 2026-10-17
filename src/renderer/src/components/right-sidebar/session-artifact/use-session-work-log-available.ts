import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLaunchedSessionPlan } from '@/lib/session-chain-registry'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { latestNativeChatTodoList } from '../../../../../shared/native-chat-todo-list'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import {
  type SessionWorkLogStatus,
  sessionWorkLogTurns,
  statusWorkLogTurns
} from './session-work-log'

/** The hook fields the log reads; shallow so a ping that changes none of them skips a render. */
export function useWorkLogStatus(session: SidebarSession | null): SessionWorkLogStatus | undefined {
  const statusKey = session ? sidebarSessionStatusKey(session) : null
  return useAppStore(
    useShallow((state): SessionWorkLogStatus | undefined => {
      const entry = statusKey ? state.agentStatusByPaneKey[statusKey] : undefined
      return entry
        ? {
            state: entry.state,
            prompt: entry.prompt,
            stateStartedAt: entry.stateStartedAt,
            stateHistory: entry.stateHistory,
            interrupted: entry.interrupted,
            failed: entry.failed,
            sessionBoundary: entry.sessionBoundary,
            lastAssistantMessage: entry.lastAssistantMessage,
            lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput,
            lastCompletedAssistantMessage: entry.lastCompletedAssistantMessage
          }
        : undefined
    })
  )
}

/**
 * Whether the Work log has anything real: a turn (from the transcript or the hook history), a
 * turn running now, the plan step that launched the session, or its task list. Why not any status:
 * a session start or resume is a boundary report, not something the session did.
 */
export function useSessionWorkLogAvailable(
  session: SidebarSession | null,
  messages: readonly NativeChatMessage[]
): boolean {
  const status = useWorkLogStatus(session)
  const launchedBy = useLaunchedSessionPlan(session?.paneKey ?? null, session ?? undefined)
  const hasTasks = useMemo(() => latestNativeChatTodoList(messages).length > 0, [messages])
  const hasTurns = useMemo(
    () => sessionWorkLogTurns(messages).length > 0 || statusWorkLogTurns(status).length > 0,
    [messages, status]
  )
  const running = status !== undefined && status.state !== 'done' && status.sessionBoundary !== true
  return session !== null && (hasTurns || running || launchedBy !== null || hasTasks)
}
