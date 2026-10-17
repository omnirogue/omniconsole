/**
 * Async questions the person dismissed on a card (closed it, or left them out of an answer). Codex
 * keeps no copy of its own past the turn that asked them, so the pane's row drops them for good.
 */

import {
  keepQuestions,
  MAX_OPEN_QUESTIONS,
  MAX_QUESTION,
  type CodexAsyncAsk,
  type CodexAsyncAskEnvelope
} from './codex-async-question'

/** One question as a card showed it: its words, and its asking when the listener stamped one. */
export type ShownAsyncQuestion = { question: string; askedAt?: number }

/** `agentStatus:dismissAsyncQuestions`: the pane, and the questions its card dismissed. */
export type AsyncQuestionDismissal = { paneKey: string; questions: ShownAsyncQuestion[] }

/** A card's questions as the window sent them, or null when any of them is malformed. */
export function parseShownAsyncQuestions(value: unknown): ShownAsyncQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPEN_QUESTIONS) {
    return null
  }
  const questions: ShownAsyncQuestion[] = []
  for (const entry of value) {
    const { question, askedAt } = (entry ?? {}) as { question?: unknown; askedAt?: unknown }
    if (typeof question !== 'string' || question.length > MAX_QUESTION) {
      return null
    }
    if (askedAt !== undefined && (typeof askedAt !== 'number' || !Number.isFinite(askedAt))) {
      return null
    }
    questions.push(askedAt === undefined ? { question } : { question, askedAt })
  }
  return questions
}

export function parseAsyncQuestionDismissal(value: unknown): AsyncQuestionDismissal | null {
  const record = value as { paneKey?: unknown; questions?: unknown } | null
  const questions = parseShownAsyncQuestions(record?.questions)
  return typeof record?.paneKey === 'string' && questions
    ? { paneKey: record.paneKey, questions }
    : null
}

/** The ask left once the person dismissed `shown` on a card; the same words asked again since
 *  (a later `askedAt`) stay. */
export function withoutDismissedCodexAsyncQuestions(
  ask: CodexAsyncAsk,
  shown: readonly ShownAsyncQuestion[]
): CodexAsyncAsk | null {
  return keepQuestions(
    ask,
    ask.envelope.asyncQuestions.map(
      (open) =>
        !shown.some(
          (dismissed) => dismissed.question === open.question && dismissed.askedAt === open.askedAt
        )
    )
  )
}

/** A status's envelope as an ask: a row restored from disk was never heard asked here. */
export function codexAsyncAskFromEnvelope(envelope: CodexAsyncAskEnvelope): CodexAsyncAsk {
  return {
    envelope,
    sources: envelope.asyncQuestions.map((_, index) => ({ toolUseId: undefined, index }))
  }
}
