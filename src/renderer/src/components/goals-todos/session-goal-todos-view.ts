import type { AgentTodo } from '../../../../shared/agent-todo-list'
import type { SessionGoal } from '../../../../shared/session-goal'
import type { SessionTodoList, SessionTodoSource } from '../../../../shared/session-todo-list'
import type { GoalsTodosDetails } from './goals-todos-rows'
import type { SessionPullRequestMention } from '../../../../shared/session-pull-request-refs'

/** What the session info panel shows for one session's goal and to-do list. */
export type SessionGoalTodosView = {
  pullRequests?: readonly SessionPullRequestMention[]
  goal: SessionGoal | null
  todos: readonly AgentTodo[]
  source: SessionTodoSource
  /** The first read for this session has not finished yet, and nothing else is known. */
  reading: boolean
}

/**
 * Combines the shared read with the transcript the chat view already holds. The chat view's
 * list is the freshest and costs nothing, so it wins whenever it has one; the goal needs the
 * session's first prompt, which only the shared read resolves.
 */
export function sessionGoalTodosView(args: {
  details: GoalsTodosDetails | null
  /** The list from the chat view's own messages, when this panel sits on a chat view. */
  fromMessages: SessionTodoList | null
  /** Whether this session has a transcript on this computer that the shared reads can read. */
  canRead: boolean
}): SessionGoalTodosView {
  const { details, fromMessages } = args
  const list =
    fromMessages && fromMessages.source !== 'none'
      ? fromMessages
      : details
        ? { todos: details.todos, source: details.source }
        : (fromMessages ?? { todos: [], source: 'none' as const })
  return {
    pullRequests: details?.pullRequests,
    goal: details?.goal ?? null,
    todos: list.todos,
    source: list.source,
    reading: args.canRead && details === null && list.source === 'none'
  }
}
