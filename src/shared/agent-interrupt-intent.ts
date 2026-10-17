import type { AgentType } from './agent-status-types'

export type AgentInterruptInputIntent = 'plain-escape' | 'ctrl-c'

export const AGENT_INTERRUPT_SETTLE_MS = 500

export type AgentInterruptInferenceRequest = {
  paneKey: string
  baselineUpdatedAt: number
  baselineStateStartedAt: number
  baselinePrompt: string
  baselineAgentType: AgentType | undefined
  intent: AgentInterruptInputIntent
  inputCount?: number
}

export function isAgentInterruptInputIntent(intent: unknown): intent is AgentInterruptInputIntent {
  return intent === 'plain-escape' || intent === 'ctrl-c'
}

/** Escape on Gemini's ask_user or Qwen's ask_user_question dialog cancels the whole request, and
 *  neither CLI sends a hook for it, so the waiting question is inferred interrupted. */
export function isEscapeCancelledQuestionWait(
  agentType: AgentType | undefined,
  state: string,
  toolName: string | undefined,
  intent: AgentInterruptInputIntent
): boolean {
  return (
    intent === 'plain-escape' &&
    state === 'waiting' &&
    ((agentType === 'gemini' && toolName === 'ask_user') ||
      (agentType === 'qwen-code' && toolName === 'ask_user_question'))
  )
}
