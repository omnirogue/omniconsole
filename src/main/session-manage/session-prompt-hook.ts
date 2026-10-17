import { createHash } from 'node:crypto'
import { asyncAskPendingInStatus, quotedQuestionLine } from '../../shared/codex-async-question'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import { describeSessionPrompt, promptTextIncomplete, type SessionPrompt } from './session-prompt'

export function readSessionHookQuestion(raw: string | null | undefined): SessionPrompt | null {
  const parsed = parseAskFromStatus(raw)
  const question = parsed?.questions[0]
  if (
    !question ||
    parsed?.questions.length !== 1 ||
    question.multiSelect ||
    promptTextIncomplete(question.question) ||
    (question.header && promptTextIncomplete(question.header))
  ) {
    return null
  }
  const options = question.options.map((option, index) => ({
    n: index + 1,
    label: [option.label, option.description, option.preview].filter(Boolean).join('\n'),
    value: String(index + 1)
  }))
  if (options.some(({ label }) => promptTextIncomplete(label))) {
    return null
  }
  const commandText = question.header ? [question.header] : []
  return {
    ask: describeSessionPrompt('question', question.question, options, true, commandText),
    options,
    readable: true,
    subject: question.question,
    commandText,
    delivery: {
      kind: 'unavailable',
      reason:
        parsed?.delivery === 'async'
          ? "It is a Codex async question: it has no selector, so it takes a message, never a keystroke. Answer it from Needs you or the pane's question card, or send your answer as a message in its session."
          : 'The hook describes a question, but its current screen layout cannot be verified. Answer it in its own session.'
    }
  }
}

/** The message an async question's answer is: Codex's own reply layout. */
export function asyncQuestionAnswerMessage(question: string, answer: string): string {
  return `> ${quotedQuestionLine(question)}\n\n${answer}`
}

/**
 * A live pane's async question (Codex `request_user_input_async`), answerable by message: one
 * single-choice question, still pending on a finished turn, fully readable, each option's value
 * the exact message it sends. Why its asking in the fingerprint: the same words asked again are a
 * new question, and an answer checked against the old one must not reach it; the asking (not the
 * row's state time) stays the same while children start and finish around it.
 */
export function readSessionAsyncQuestion(
  hook:
    | {
        state: string
        workingMode?: string
        interactivePrompt: string | null
        stateStartedAt: number
      }
    | null
    | undefined,
  pane: { handle: string; ptyId: string }
): SessionPrompt | null {
  if (!hook || !asyncAskPendingInStatus(hook, 'async')) {
    return null
  }
  const parsed = parseAskFromStatus(hook.interactivePrompt)
  const question = parsed?.questions[0]
  if (
    parsed?.delivery !== 'async' ||
    !question ||
    parsed.questions.length !== 1 ||
    question.multiSelect ||
    promptTextIncomplete(question.question)
  ) {
    return null
  }
  const options = question.options.map((option, index) => ({
    n: index + 1,
    label: option.label,
    value: asyncQuestionAnswerMessage(question.question, option.label)
  }))
  if (options.some(({ label }) => promptTextIncomplete(label))) {
    return null
  }
  const ask = describeSessionPrompt('question', question.question, options, true, [])
  // Why the row's time only as a fallback: a host from before `askedAt` names no asking.
  const askedAt = question.askedAt ?? hook.stateStartedAt
  return {
    ask: {
      ...ask,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(['async-question/2', ask.fingerprint, askedAt]))
        .digest('hex')
    },
    options,
    readable: true,
    subject: question.question,
    commandText: [],
    delivery: {
      kind: 'message',
      handle: pane.handle,
      ptyId: pane.ptyId,
      askedAt
    }
  }
}
