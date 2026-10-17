import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isGeminiAskUserEvent } from './gemini-tool-fields'

export function normalizeGeminiEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SessionStart') {
    clearPaneTurnCacheState(state, paneKey)
    return normalizeAgentStatusPayload({
      state: 'done',
      prompt: '',
      agentType: 'gemini',
      sessionBoundary: true
    })
  }

  // Why: Gemini CLI's native pre-tool event is BeforeTool; PreToolUse/PostToolUse still accepted for legacy Antigravity-compatible payloads.
  // Why: ask_user blocks on the person; its AfterTool (answered or cancelled) resumes 'working'.
  const askUser = isGeminiAskUserEvent(eventName, readString(hookPayload, 'tool_name'))
  const stateName = askUser
    ? 'waiting'
    : eventName === 'BeforeAgent' ||
        eventName === 'BeforeTool' ||
        eventName === 'AfterTool' ||
        eventName === 'PreToolUse' ||
        eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'AfterAgent'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('gemini', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('gemini', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('gemini', eventName)
    }),
    agentType: 'gemini',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
