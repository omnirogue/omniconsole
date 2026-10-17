import { GEMINI_ASK_USER_TOOL } from '../../native-chat-gemini-ask'
import { serializeOptionOnlyAsk } from '../../native-chat-option-only-ask'
import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

/** True while Gemini's BeforeTool for `ask_user` means its question dialog is about to open. */
export function isGeminiAskUserEvent(eventName: unknown, toolName: string | undefined): boolean {
  return eventName === 'BeforeTool' && toolName === GEMINI_ASK_USER_TOOL
}

// Why: BeforeTool fires before ask_user's dialog renders, so its input is the live question.
function geminiAskUserPrompt(
  toolName: string | undefined,
  hookPayload: Record<string, unknown>
): string | undefined {
  return toolName === GEMINI_ASK_USER_TOOL
    ? serializeOptionOnlyAsk(hookPayload.tool_input)
    : undefined
}

export function extractGeminiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'BeforeTool' ||
    eventName === 'AfterTool' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input)
    return toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt:
          eventName === 'BeforeTool' ? geminiAskUserPrompt(toolName, hookPayload) : undefined
      },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'args', 'input']) }
    )
  }
  if (eventName === 'AfterAgent') {
    const message = readString(hookPayload, 'prompt_response')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
