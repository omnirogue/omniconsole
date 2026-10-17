import type { LLMToolCall } from '../core/llm/types'

export function parseLogToolArguments(toolCall: LLMToolCall): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(toolCall.function?.arguments ?? '{}')
  } catch {
    parsed = 'args' in toolCall ? toolCall.args : null
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : null
}
