import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isNewTurnEvent } from './agent-hook-listener/provider-event-routing'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'

export const SOURCE_PROMPT_MAX_LENGTH = 256_000

/** The prompt text a hook body carries, exactly as submitted (launch discovery guidance included). */
export function submittedHookPromptText(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  let raw = (body as Record<string, unknown>).payload
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const payload = raw as Record<string, unknown>
  if (payload.role !== undefined && payload.role !== 'user') {
    return null
  }
  for (const key of [
    'prompt',
    'user_prompt',
    'userPrompt',
    'initial_prompt',
    'initialPrompt',
    'user_message'
  ]) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return payload.role === 'user' && typeof payload.text === 'string' ? payload.text : null
}

/** Only live, directly submitted root turns can supply private outcome authority. */
export function submittedHookSourcePrompt(
  event: AgentHookEventPayload,
  body: unknown
): string | null {
  if (
    !event.hasExplicitPrompt ||
    event.isReplay ||
    event.toolAgentId ||
    event.providerSessionOnly ||
    !event.launchToken?.trim() ||
    !event.worktreeId?.trim() ||
    !event.source ||
    (!isNewTurnEvent(event.source, event.hookEventName) &&
      !(
        (event.source === 'opencode' || event.source === 'mimo-code') &&
        event.hookEventName === 'MessagePart'
      ))
  ) {
    return null
  }
  const prompt = submittedHookPromptText(body)
  return prompt &&
    prompt.length <= SOURCE_PROMPT_MAX_LENGTH &&
    !isKnownHarnessInjectedUserTurnText(prompt)
    ? prompt
    : null
}
