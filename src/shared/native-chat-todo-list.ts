// The newest agent-published task list inside an already-assembled native chat
// transcript. Why here and not a new reader: the transcript is assembled once for the
// chat view, and its tool-call blocks keep the tool's full input — so the task list is
// already in memory, and reading it again from disk would be a second reader for data
// the renderer is holding.

import { type AgentTodo, isAgentTodoToolName, parseAgentTodoList } from './agent-todo-list'
import { isToolCallBlock, type NativeChatMessage } from './native-chat-types'

/** How far back to look. A list older than this is stale for "what it is doing now". */
export const NATIVE_CHAT_TODO_SCAN_LIMIT = 300

/**
 * The last task list the agent published, or `[]` when it published none. Scans newest
 * first and stops at the first real list, so a later empty publish does not resurrect an
 * older one: an agent that clears its list is reported as having no list.
 */
export function latestNativeChatTodoList(
  messages: readonly NativeChatMessage[],
  scanLimit = NATIVE_CHAT_TODO_SCAN_LIMIT
): readonly AgentTodo[] {
  const start = Math.max(0, messages.length - scanLimit)
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (!message) {
      continue
    }
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]
      if (!block || !isToolCallBlock(block) || !isAgentTodoToolName(block.name)) {
        continue
      }
      return parseAgentTodoList(block.input)
    }
  }
  return []
}
