import type { NativeChatMessage } from './native-chat-types'
import type { AgentStatusEntry } from './agent-status-types'
import { sessionGoalFromPrompt, type SessionGoal } from './session-goal'
import { assistantProse } from './session-handoff-summary'
import { isSessionManageMarkedPrompt } from './session-manage-types'
import { latestSessionTodoList } from './session-todo-list'

export type SessionCompactContext = {
  goal: string | null
  latestRequest: string | null
  latestUpdate: string | null
  nextStep: string | null
}

function compact(text: string | null | undefined, max: number): string | null {
  const line = text?.replace(/\s+/g, ' ').trim()
  return line ? (line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line) : null
}

/** A bounded description of the current turn; a new ask cannot inherit an old "finished". */
export function compactSessionContext(
  messages: readonly NativeChatMessage[],
  goal: SessionGoal | null = null
): SessionCompactContext {
  let latestRequest: string | null = null
  let latestUpdate: string | null = null
  let currentTurn: NativeChatMessage[] = []
  let machineTurn = false
  for (const message of messages) {
    const prose = assistantProse(message)
    if (message.role === 'user') {
      if (isSessionManageMarkedPrompt(prose)) {
        machineTurn = true
        continue
      }
      const request = sessionGoalFromPrompt(prose)
      if (!request) {
        continue
      }
      machineTurn = false
      latestRequest = compact(request.full, 240)
      latestUpdate = null
      currentTurn = []
      continue
    }
    if (machineTurn) {
      continue
    }
    currentTurn.push(message)
    if (message.role === 'assistant' && prose) {
      latestUpdate = compact(prose, 360)
    }
  }
  const { todos } = latestSessionTodoList(currentTurn)
  const next =
    todos.find((todo) => todo.status === 'current') ??
    todos.find((todo) => todo.status === 'pending')
  return {
    goal: compact(goal?.full, 240),
    latestRequest,
    latestUpdate,
    nextStep: compact(next?.text, 160)
  }
}

/** Remote and structured sessions use only prose their execution host already published. */
export function publishedSessionContext(
  entry:
    | {
        prompt?: string
        lastAssistantMessage?: string
        lastAssistantMessageIsToolOutput?: boolean
      }
    | null
    | undefined
): SessionCompactContext {
  const prompt = entry?.prompt
  const request =
    prompt && !isSessionManageMarkedPrompt(prompt) ? sessionGoalFromPrompt(prompt) : null
  return {
    goal: null,
    latestRequest: compact(request?.full, 240),
    latestUpdate:
      request && !entry?.lastAssistantMessageIsToolOutput
        ? compact(entry?.lastAssistantMessage, 360)
        : null,
    nextStep: null
  }
}

/** A newer working turn invalidates cached progress even when the person repeats the same ask. */
export function sessionContextForHover(
  context: SessionCompactContext | undefined,
  lastMessageAt: number | null,
  entry:
    | Pick<
        AgentStatusEntry,
        | 'prompt'
        | 'lastAssistantMessage'
        | 'lastAssistantMessageIsToolOutput'
        | 'updatedAt'
        | 'state'
        | 'stateStartedAt'
      >
    | null
    | undefined
): SessionCompactContext {
  const published = publishedSessionContext(entry)
  if (!context) {
    return published
  }
  const newerTurn = entry?.state === 'working' && entry.stateStartedAt > (lastMessageAt ?? 0)
  const changedRequest =
    published.latestRequest !== context.latestRequest &&
    (entry?.updatedAt ?? 0) >= (lastMessageAt ?? 0)
  if (published.latestRequest && (newerTurn || changedRequest)) {
    return { ...published, goal: context.goal }
  }
  return context
}
