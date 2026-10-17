/**
 * A message answer to an agent's async question (Codex `request_user_input_async`), handed to the
 * host that owns the terminal. The host writes it only while it can prove the agent itself holds
 * that terminal: the same message landing in a shell would run as a command.
 */

import { parseShownAsyncQuestions, type ShownAsyncQuestion } from './codex-async-question-dismissal'

export const AGENT_QUESTION_ANSWER_CHANNEL = 'pty:answerAgentQuestion'

/** Bounds one answer; eight questions with typed answers stay far below it. */
export const AGENT_QUESTION_ANSWER_MAX_CHARS = 32_000

export type AgentQuestionAnswerRequest = {
  ptyId: string
  paneKey: string
  text: string
  clientMessageId: string
  /** Questions the card showed that this answer leaves out; the host dismisses them once it lands. */
  leftOut?: ShownAsyncQuestion[]
}

export type AgentQuestionAnswerOutcome =
  | { status: 'delivered' }
  /** Nothing was written: safe to try again once the reason is gone. */
  | { status: 'not-sent'; reason: string }
  /** Some of it may have reached the terminal: never sent again. */
  | { status: 'unconfirmed'; reason: string }

export function isAgentQuestionAnswerRequest(value: unknown): value is AgentQuestionAnswerRequest {
  const request = value as Partial<AgentQuestionAnswerRequest> | null
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof request.ptyId === 'string' &&
    request.ptyId.length > 0 &&
    typeof request.paneKey === 'string' &&
    request.paneKey.length > 0 &&
    typeof request.clientMessageId === 'string' &&
    request.clientMessageId.length > 0 &&
    typeof request.text === 'string' &&
    request.text.length <= AGENT_QUESTION_ANSWER_MAX_CHARS &&
    (request.leftOut === undefined || parseShownAsyncQuestions(request.leftOut) !== null)
  )
}
