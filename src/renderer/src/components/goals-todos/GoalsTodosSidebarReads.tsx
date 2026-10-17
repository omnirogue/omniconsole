import { memo } from 'react'
import { useMinuteTick } from '@/lib/conversation-retention'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useGoalsTodosInputs } from './use-goals-todos'
import { useGoalsTodosReads } from './use-goals-todos-details'

/**
 * Keeps the Conversations list's sessions read for their to-do badges, through the same
 * bounded set and shared scheduler as the Goals & to-dos view (at most 100 sessions from the
 * last week, one read per session per 15 s, two at a time). Renders nothing; a separate
 * component so status pings re-render this, not the whole list.
 */
export const GoalsTodosSidebarReads = memo(function GoalsTodosSidebarReads({
  sessions
}: {
  sessions: readonly SidebarSession[]
}): null {
  const now = useMinuteTick()
  const { requests } = useGoalsTodosInputs(sessions, now)
  useGoalsTodosReads(requests)
  return null
})
