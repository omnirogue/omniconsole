// The one to-do list a session shows, from an already-assembled transcript window. A list
// the agent published through a tool (TodoWrite, update_plan, a structured plan block) is
// authoritative; only when none exists does a plan written as prose count.

import { latestAssistantTextPlan } from './agent-text-plan'
import {
  isAgentTodoToolName,
  parseAgentTodoList,
  type AgentTodo,
  type AgentTodoStatus
} from './agent-todo-list'
import type { NativeChatPlanEntry } from './native-chat-plan'
import { isTextBlock, isToolCallBlock, type NativeChatMessage } from './native-chat-types'
import { NATIVE_CHAT_TODO_SCAN_LIMIT } from './native-chat-todo-list'

/** Where the list came from: a task tool, the agent's own prose, or nowhere. */
export type SessionTodoSource = 'tool' | 'text' | 'none'

export type SessionTodoList = {
  todos: readonly AgentTodo[]
  source: SessionTodoSource
}

const NONE: SessionTodoList = { todos: [], source: 'none' }

function planEntryStatus(status: NativeChatPlanEntry['status']): AgentTodoStatus {
  return status === 'in_progress' ? 'current' : status
}

/** The newest structured list, or null when the window holds none (an emptied list is `[]`). */
function latestStructuredTodos(
  messages: readonly NativeChatMessage[],
  scanLimit: number
): readonly AgentTodo[] | null {
  const start = Math.max(0, messages.length - scanLimit)
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const blocks = messages[index]?.blocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (!block) {
        continue
      }
      if (isToolCallBlock(block) && isAgentTodoToolName(block.name)) {
        return parseAgentTodoList(block.input)
      }
      if (isTextBlock(block) && block.plan) {
        return parseAgentTodoList(
          block.plan.entries.map((entry) => ({
            content: entry.content,
            status: planEntryStatus(entry.status)
          }))
        )
      }
    }
  }
  return null
}

export function latestSessionTodoList(
  messages: readonly NativeChatMessage[],
  scanLimit = NATIVE_CHAT_TODO_SCAN_LIMIT
): SessionTodoList {
  const structured = latestStructuredTodos(messages, scanLimit)
  if (structured) {
    return structured.length > 0 ? { todos: structured, source: 'tool' } : NONE
  }
  const written = latestAssistantTextPlan(messages, scanLimit)
  return written.length > 0 ? { todos: written, source: 'text' } : NONE
}
