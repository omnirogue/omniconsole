/**
 * Questions sessions ask the person (AskUserQuestion and each agent's equivalent), read from the
 * pane's live hook status: what Needs you lists with one-click answers, and what
 * `omni session questions` prints. A question is pending only while its pane still waits on it.
 */

import { z } from 'zod'
import type { AgentStatusState, AgentWorkingMode } from './agent-status-types'
import { asyncAskPendingInStatus } from './codex-async-question'
import { parseAskFromStatus } from './native-chat-ask'
import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

export const SESSION_QUESTIONS_RPC = { list: 'sessionQuestions.list' } as const

export const SessionQuestionsParamsSchema = z.object({}).strict()

/** One pane's pending question(s), as `omni session questions --json` lists them. */
export type PendingSessionQuestion = {
  paneKey: string
  /** The sidebar title; null when no window could say. */
  title: string | null
  agent: string | null
  /** Epoch ms the pane started waiting on it. */
  askedAt: number
  /** The tool call that asked (Claude's `tool_use_id`), when the hook reported it. */
  toolUseId: string | null
  /** The provider's session id (Claude's `session_id`), when known. */
  sessionId: string | null
  questions: AskQuestion[]
  /** `async`: the agent took no selector (Codex's `request_user_input_async`); answer it with a message. */
  delivery?: 'async'
}

export type SessionQuestionsResult = { questions: PendingSessionQuestion[] }

/** The question a pane waits on now, or null (no question, or the agent moved on). An async
 *  question (Codex's) is still pending on the finished turn that asked it. */
export function pendingSessionAsk(status: {
  state: AgentStatusState | 'idle'
  workingMode?: AgentWorkingMode | null
  interactivePrompt?: string | null
  toolName?: string | null
}): AskPrompt | null {
  // Why first: no ask of any kind is pending in this state, so skip parsing its prompt.
  if (!asyncAskPendingInStatus(status, 'async') && !asyncAskPendingInStatus(status, undefined)) {
    return null
  }
  const ask = parseAskFromStatus(status.interactivePrompt, status.toolName ?? undefined)
  return ask && ask.questions.length > 0 && asyncAskPendingInStatus(status, ask.delivery)
    ? ask
    : null
}

/** One line for a question: its text, and how many more it asks at once. */
export function sessionQuestionSummary(ask: AskPrompt): string {
  const first = ask.questions[0]?.question.trim() ?? ''
  const more = ask.questions.length - 1
  return more > 0 ? `${first} (+${more} more)` : first
}

/**
 * One question's identity across every pane that shows it: the provider conversation plus the
 * question itself. Why the prompt and not a pane: a conversation resumed into a second pane (or
 * mirrored to another computer) repeats the same hook status under another pane key, and the
 * person must see and answer it once. Null when the pane waits on nothing, or when no
 * conversation id is known (then the pane is the only identity there is).
 */
export function sessionQuestionIdentity(status: {
  state: AgentStatusState | 'idle'
  workingMode?: AgentWorkingMode | null
  interactivePrompt?: string | null
  toolName?: string | null
  providerSession?: { id: string } | null
}): string | null {
  const sessionId = status.providerSession?.id?.trim()
  if (!sessionId || !status.interactivePrompt || !pendingSessionAsk(status)) {
    return null
  }
  return `${sessionId}\n${status.interactivePrompt}`
}
