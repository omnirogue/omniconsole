import { translate } from '@/i18n/i18n'
import { agentTodoProgress, type AgentTodo } from '../../../../shared/agent-todo-list'
import type { GoalsTodosDetails } from './goals-todos-rows'

export type GoalsTodosProgress = {
  completed: number
  total: number
  current: AgentTodo | null
}

/** "3 of 7 done", or "All 7 done" once nothing is left. */
export function goalsTodosProgressLabel(progress: GoalsTodosProgress): string {
  return progress.completed === progress.total
    ? translate('goalsTodos.allDone', 'All {{total}} done', { total: progress.total })
    : translate('goalsTodos.progress', '{{done}} of {{total}} done', {
        done: progress.completed,
        total: progress.total
      })
}

/** "Now: …" for the step in progress, "Next: …" when none is marked; null once all are done. */
export function goalsTodosStepLabel(progress: GoalsTodosProgress): string | null {
  if (!progress.current || progress.completed === progress.total) {
    return null
  }
  return progress.current.status === 'current'
    ? translate('goalsTodos.now', 'Now: {{step}}', { step: progress.current.text })
    : translate('goalsTodos.next', 'Next: {{step}}', { step: progress.current.text })
}

export type SessionTodoBadge = {
  /** "3/7": short enough to sit beside a truncated row name. */
  text: string
  /** Spoken form of the count, for screen readers. */
  label: string
  done: boolean
  /** The hover: what the session is for and where it is in its list. */
  goal: string | null
  step: string | null
}

/**
 * The Conversations row badge, or null when the session has published no to-do list (or has
 * not been read yet): a row without a list stays exactly as it was.
 */
export function sessionTodoBadge(details: GoalsTodosDetails | null): SessionTodoBadge | null {
  if (!details || details.todos.length === 0) {
    return null
  }
  const progress = agentTodoProgress(details.todos)
  if (progress.total === 0) {
    return null
  }
  return {
    text: `${progress.completed}/${progress.total}`,
    label: goalsTodosProgressLabel(progress),
    done: progress.completed === progress.total,
    goal: details.goal?.line ?? null,
    step: goalsTodosStepLabel(progress)
  }
}
