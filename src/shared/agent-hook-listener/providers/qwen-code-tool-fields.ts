import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { serializeOptionOnlyAsk } from '../../native-chat-option-only-ask'
import type { ToolSnapshot } from '../listener-event'
import { readString } from '../tool-input-preview'
import { extractClaudeToolFields } from './claude-tool-fields'

/** Qwen Code sends Claude-shaped tool payloads; its question arrives at PermissionRequest. */
export function extractQwenCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'Stop') {
    // Why not the transcript: Qwen's chat log is not Claude's format.
    const message = readString(hookPayload, 'last_assistant_message')
    return message ? { lastAssistantMessage: message } : {}
  }
  const update = extractClaudeToolFields(eventName, hookPayload)
  // Why: Qwen's PreToolUse for ask_user_question fires only AFTER the answer; a prompt there would reopen the card.
  if (eventName !== 'PermissionRequest' && update.interactivePrompt !== undefined) {
    return { ...update, interactivePrompt: undefined }
  }
  if (eventName === 'PermissionRequest' && isAskUserQuestionTool(update.toolName)) {
    return { ...update, interactivePrompt: serializeOptionOnlyAsk(hookPayload.tool_input) }
  }
  return update
}
