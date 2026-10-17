import { useMemo } from 'react'
import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  withAgentTodoKeys,
  type AgentTodo,
  type AgentTodoStatus
} from '../../../../shared/agent-todo-list'

function statusLabel(status: AgentTodoStatus): string {
  switch (status) {
    case 'completed':
      return translate('sessionActivity.todoDone', 'Done')
    case 'current':
      return translate('sessionActivity.todoDoingNow', 'Doing now')
    case 'pending':
      return translate('sessionActivity.todoTodo', 'To do')
  }
}

function TodoIcon({ status }: { status: AgentTodoStatus }): React.JSX.Element {
  const className = 'size-3 shrink-0'
  switch (status) {
    case 'completed':
      return <CircleCheck className={cn(className, 'text-emerald-500')} aria-hidden />
    case 'current':
      return <CircleDot className={cn(className, 'text-sky-500')} aria-hidden />
    case 'pending':
      return <Circle className={cn(className, 'text-muted-foreground/60')} aria-hidden />
  }
}

/** The task list the agent itself published, in its own order: ticked, current, still to do. */
export function SessionActivityTodoList({
  todos
}: {
  todos: readonly AgentTodo[]
}): React.JSX.Element {
  const keyed = useMemo(() => withAgentTodoKeys(todos), [todos])
  return (
    <ol
      className="scrollbar-sleek mt-1 max-h-40 space-y-0.5 overflow-y-auto"
      data-session-activity-todos={todos.length}
      aria-label={translate('sessionActivity.todoListLabel', 'Tasks this session published')}
    >
      {keyed.map((todo) => (
        <li
          key={todo.key}
          className="flex min-w-0 items-start gap-1.5"
          data-session-activity-todo={todo.status}
        >
          <span className="mt-0.5 inline-flex" role="img" aria-label={statusLabel(todo.status)}>
            <TodoIcon status={todo.status} />
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-normal break-words',
              todo.status === 'completed' && 'text-muted-foreground line-through',
              todo.status === 'current' && 'font-medium',
              todo.status === 'pending' && 'text-muted-foreground'
            )}
          >
            {todo.text}
          </span>
        </li>
      ))}
    </ol>
  )
}
