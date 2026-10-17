import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  sessionContextForHover,
  type SessionCompactContext
} from '../../../../shared/session-compact-context'
import { goalsTodosReadRequest, goalsTodosStatusSignature } from './goals-todos-requests'
import { goalsTodosKey } from './goals-todos-rows'
import { useGoalsTodosEntry, useGoalsTodosReads } from './use-goals-todos-details'

/** Mounted only inside the open hover; shares the existing bounded transcript read cache. */
export function useSessionCompactContext(
  session: SidebarSession,
  entry: AgentStatusEntry | null | undefined
): SessionCompactContext {
  const signature = useAppStore((state) => goalsTodosStatusSignature(state, session.paneKey))
  const requests = useMemo(() => {
    const request = goalsTodosReadRequest(session, signature)
    return request ? [request] : []
  }, [session, signature])
  useGoalsTodosReads(requests)
  const details = useGoalsTodosEntry(goalsTodosKey(session))
  return sessionContextForHover(details?.context, details?.lastMessageAt ?? null, entry)
}
