// Agent-published task lists ("todos"), read from whatever the agent actually wrote.
// Why parse rather than model: no agent owes us this data. Claude's TodoWrite carries
// `{ todos: [{ content, status }] }`, Codex's plan tool carries `{ plan: [{ step, status }] }`,
// and most turns publish neither. Everything here returns an empty list on anything it does
// not recognise, so a surface can only ever show a list the agent really published.

/** Task states every known publisher maps onto. */
export type AgentTodoStatus = 'completed' | 'current' | 'pending'

export type AgentTodo = {
  text: string
  status: AgentTodoStatus
}

/** Tool names (lowercased) that publish a task list. */
const TODO_TOOL_NAMES: ReadonlySet<string> = new Set([
  'todowrite',
  'todo_write',
  'todoswrite',
  'update_plan',
  'updateplan'
])

/** Bounds a pathological payload: a list longer than this is truncated, never rendered whole. */
export const AGENT_TODO_MAX_ITEMS = 50
/** Bounds one item's text; the surfaces truncate visually too. */
export const AGENT_TODO_MAX_TEXT = 200

export function isAgentTodoToolName(name: string): boolean {
  return TODO_TOOL_NAMES.has(name.trim().toLowerCase())
}

function normalizeStatus(value: unknown): AgentTodoStatus {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : ''
  switch (text) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'finished':
      return 'completed'
    case 'in_progress':
    case 'inprogress':
    case 'active':
    case 'current':
    case 'running':
      return 'current'
    default:
      return 'pending'
  }
}

function itemText(item: Record<string, unknown>): string {
  // Why this order: `content`/`step` are the canonical fields; `activeForm` ("Running tests")
  // is only a present-tense restatement, so it is a last resort, never a replacement.
  for (const key of ['content', 'step', 'title', 'text', 'task', 'description', 'activeForm']) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, AGENT_TODO_MAX_TEXT)
    }
  }
  return ''
}

function readItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  const record = value as Record<string, unknown>
  for (const key of ['todos', 'plan', 'items', 'tasks', 'steps']) {
    const candidate = record[key]
    if (Array.isArray(candidate)) {
      return candidate
    }
  }
  return []
}

/**
 * The task list inside a tool payload, or `[]` when the payload is not a task list.
 * A JSON string is accepted because hook and transcript sources disagree on whether the
 * tool input arrives parsed.
 */
export function parseAgentTodoList(input: unknown): readonly AgentTodo[] {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  const todos: AgentTodo[] = []
  for (const item of readItems(value)) {
    if (todos.length >= AGENT_TODO_MAX_ITEMS) {
      break
    }
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) {
        todos.push({ text: text.slice(0, AGENT_TODO_MAX_TEXT), status: 'pending' })
      }
      continue
    }
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    const text = itemText(record)
    if (text) {
      todos.push({ text, status: normalizeStatus(record.status ?? record.state) })
    }
  }
  return todos
}

/**
 * The same list with a stable identity per task. Why the text and not the position: a task
 * keeps its wording across republishes while its position moves as the agent ticks items
 * off, so the text is the identity a re-render must follow. Repeated wording gets an
 * occurrence suffix so the keys stay unique.
 */
export function withAgentTodoKeys(
  todos: readonly AgentTodo[]
): readonly (AgentTodo & { key: string })[] {
  const seen = new Map<string, number>()
  return todos.map((todo) => {
    const count = seen.get(todo.text) ?? 0
    seen.set(todo.text, count + 1)
    return { ...todo, key: count === 0 ? todo.text : `${todo.text}#${count}` }
  })
}

/** How far through a published list the agent is. */
export function agentTodoProgress(todos: readonly AgentTodo[]): {
  completed: number
  total: number
  current: AgentTodo | null
} {
  const completed = todos.filter((todo) => todo.status === 'completed').length
  // Why the pending fallback: some publishers mark nothing "in progress" and simply
  // tick items off, so the first unfinished task is the honest "current" one.
  const current =
    todos.find((todo) => todo.status === 'current') ??
    todos.find((todo) => todo.status === 'pending') ??
    null
  return { completed, total: todos.length, current }
}
