import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { extractToolResponseText, parseJsonObjectString } from '../interactive-tool'
import { HERMES_CLARIFY_TOOL } from '../../native-chat-hermes-ask'
import { serializeOptionOnlyAsk } from '../../native-chat-option-only-ask'

/** True while Hermes' pre_tool_call for `clarify` means its question UI is about to block. */
export function isHermesClarifyEvent(eventName: unknown, toolName: string | undefined): boolean {
  return eventName === 'pre_tool_call' && toolName === HERMES_CLARIFY_TOOL
}

// Why: the managed plugin forwards clarify's args as tool_input before the blocking UI opens.
function hermesClarifyPrompt(hookPayload: Record<string, unknown>): string | undefined {
  const raw = hookPayload.tool_input ?? hookPayload.args
  const input = typeof raw === 'string' ? parseJsonObjectString(raw) : raw
  return input && typeof input === 'object' ? serializeOptionOnlyAsk(input) : undefined
}

export function extractHermesToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'pre_tool_call' ||
    eventName === 'post_tool_call' ||
    eventName === 'pre_approval_request' ||
    eventName === 'post_approval_response'
  ) {
    const toolName =
      readString(hookPayload, 'tool_name') ??
      readString(hookPayload, 'name') ??
      (eventName === 'pre_approval_request' || eventName === 'post_approval_response'
        ? 'approval'
        : undefined)
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      // Why: Hermes has many tool names; fall back to obvious arg fields so a new name still shows a value, not a blank row.
      deriveFallbackToolInputPreview(hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.args) ??
      deriveFallbackToolInputPreview(hookPayload.input) ??
      readString(hookPayload, 'command') ??
      readString(hookPayload, 'description')
    const update: ToolSnapshot = toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt: isHermesClarifyEvent(eventName, toolName)
          ? hermesClarifyPrompt(hookPayload)
          : undefined
      },
      {
        hasToolInputField: hasAnyOwnField(hookPayload, [
          'tool_input',
          'args',
          'input',
          'command',
          'description'
        ])
      }
    )
    if (eventName === 'post_tool_call') {
      const responseText =
        extractToolResponseText(hookPayload.result) ??
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.output)
      if (responseText) {
        update.lastAssistantMessage = responseText
        update.lastAssistantMessageIsToolOutput = true
      }
    }
    return update
  }
  if (eventName === 'post_llm_call') {
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readString(hookPayload, 'assistant_response') ??
      readString(hookPayload, 'response_text')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
