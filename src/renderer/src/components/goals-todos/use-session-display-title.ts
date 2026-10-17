import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionDisplayTitle } from '@/lib/session-goal-title'
import { goalsTodosKey } from './goals-todos-rows'
import { useGoalsTodosEntry } from './use-goals-todos-details'

/** The row's name, with the goal standing in for a junk title the app set; reads nothing new. */
export function useSessionDisplayTitle(session: SidebarSession): string {
  const goal = useGoalsTodosEntry(goalsTodosKey(session))?.goal
  return sessionDisplayTitle(session, goal)
}
