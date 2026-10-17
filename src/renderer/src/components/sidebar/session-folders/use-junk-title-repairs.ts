import { useMemo, useSyncExternalStore } from 'react'
import { goalsTodosKey } from '@/components/goals-todos/goals-todos-rows'
import {
  cachedGoalsTodosDetails,
  goalsTodosVersion,
  subscribeGoalsTodos
} from '@/components/goals-todos/goals-todos-store'
import { junkCustomTitleRepairs, type JunkTitleRepair } from '@/lib/session-goal-title'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { appTitleStore } from '@/lib/session-organization-title'

/** Launcher titles a session's goal would name better, re-read as goals arrive. */
export function useJunkTitleRepairs(sessions: readonly SidebarSession[]): JunkTitleRepair[] {
  const version = useSyncExternalStore(subscribeGoalsTodos, goalsTodosVersion)
  return useMemo(() => {
    // Why the void: a completed goal read bumps the version; the cache it filled is the input.
    void version
    return junkCustomTitleRepairs(
      sessions,
      (session) => cachedGoalsTodosDetails(goalsTodosKey(session))?.goal,
      // Why read here: a title change always rewrites the sessions, which re-runs this.
      (tabId) => {
        const read = appTitleStore.read(tabId)
        return read.known ? read.origin : undefined
      }
    )
  }, [sessions, version])
}
