import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useLaunchedSessionPlan } from '@/lib/session-chain-registry'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { latestNativeChatTodoList } from '../../../../shared/native-chat-todo-list'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { SessionActivityTodoList } from './SessionActivityTodoList'
import { activityPreviewOf } from './session-activity'
import { activityAbsoluteTime, latestAssistantText } from './session-activity-text'
import { useSessionActivity } from './use-session-activity'

/**
 * What this session is doing, on the session's own detail surface: the plan step that
 * launched it, the task list it published, or its live hook activity — and "Status unknown"
 * when none of those exist, rather than an empty strip that reads like idleness.
 *
 * Reads only state the app already holds: the agent-hook row for the pane, the plan
 * registry, and the transcript the chat view assembled. It starts no timer and no request.
 * When the line would only repeat the assistant message the transcript already shows right
 * below, the status ("Finished its turn · 4 min ago") takes its place instead.
 */
export function SessionActivityPanel({
  session,
  messages,
  showTodoList = true
}: {
  session: SidebarSession
  /** The transcript already rendered by the chat view; no additional history request. */
  messages?: readonly NativeChatMessage[]
  /** Off where the mount shows the session's to-do list itself; the line still uses it. */
  showTodoList?: boolean
}): React.JSX.Element {
  const launchedBy = useLaunchedSessionPlan(session.paneKey, session)
  const todos = useMemo(() => (messages ? latestNativeChatTodoList(messages) : []), [messages])
  const shownBelow = useMemo(
    () => (messages ? activityPreviewOf(latestAssistantText(messages)) : null),
    [messages]
  )
  const activity = useSessionActivity({
    paneKey: sidebarSessionStatusKey(session),
    launchedBy,
    todos
  })
  const echoed = activity.quotesAgent && shownBelow !== null && shownBelow === activity.line
  const at = activity.state?.at ?? null
  const absolute = at === null ? undefined : activityAbsoluteTime(at)
  const line = echoed ? (activity.state?.line ?? activity.line) : activity.line
  return (
    <div
      className="min-w-0 text-xs"
      data-session-activity={activity.signal}
      data-session-activity-echoed={echoed ? '' : undefined}
      aria-label={translate('sessionActivity.regionLabel', 'What this session is doing')}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="min-w-0 flex-1 truncate font-medium"
          data-session-activity-line
          title={echoed ? absolute : activity.full}
        >
          {line}
        </span>
        {activity.state && !echoed ? (
          <span
            className="shrink-0 text-muted-foreground"
            data-session-activity-state={activity.state.state}
            title={absolute}
          >
            {activity.state.line}
          </span>
        ) : null}
      </div>
      {activity.detail ? (
        <p className="min-w-0 truncate text-muted-foreground" data-session-activity-detail>
          {activity.detail}
        </p>
      ) : null}
      {showTodoList && activity.todos.length > 0 ? (
        <SessionActivityTodoList todos={activity.todos} />
      ) : null}
    </div>
  )
}
