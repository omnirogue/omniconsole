import { SessionManageRefusal } from './session-manage-refusal'
import type { SessionAnswerQuarantine } from './session-answer-quarantine'
import type { SessionPrompt } from './session-prompt'

export const structuredAnswerQuarantineKey = (sessionId: string, itemId: string): string =>
  `structured:${JSON.stringify([sessionId, itemId])}`

const ASYNC_QUESTION_MARKER = 'async-question:'

/** One asking of one async question: a message answer reaches only that question. */
export const asyncQuestionAnswerQuarantineKey = (
  pane: string,
  askedAt: number,
  question: string
): string => `${ASYNC_QUESTION_MARKER}${JSON.stringify([pane, askedAt, question])}`

/**
 * The per-pane answer lock. `admit` refuses while an earlier answer to this pane may already have
 * reached its target with no confirmed outcome. PTYs use the pane; structured responses use
 * their exact session/item. Only verified departure or proven no-write releases a marker.
 */
export type SessionAnswerLock = {
  readonly uncertain: boolean
  bindPrompt(prompt: SessionPrompt | undefined): void
  admit(): void
  markUncertain(evidence?: unknown): void
  leftPrompt(): void
}

const answering = new Set<string>()
/** The message-answer marker each pane last left, so it goes once Codex asks something new. */
const messageMarkerByPane = new Map<string, string>()
/**
 * Panes whose last answer may have reached a prompt unconfirmed. A redraw, changed hook or even a
 * different command cannot prove the earlier menu closed.
 */
const uncertainAnswers = new Set<string>()

/**
 * One answer per pane at a time. After an answer that may have landed unconfirmed, that same
 * PTY pane refuses later answers until positive readings verify departure. Structured prompts
 * retain each unknown item independently while distinct explicitly addressed items may proceed.
 */
export async function withSessionAnswerLock<T>(
  key: string,
  task: (lock: SessionAnswerLock) => Promise<T>,
  quarantine: SessionAnswerQuarantine = uncertainAnswers
): Promise<T> {
  if (answering.has(key)) {
    throw new SessionManageRefusal(
      'Another answer to this session is already in progress. Nothing was sent.'
    )
  }
  answering.add(key)
  let quarantineKey = key
  const pending = () =>
    quarantine.has(key) || (quarantineKey !== key && quarantine.has(quarantineKey))
  const lock: SessionAnswerLock = {
    bindPrompt(prompt) {
      const delivery = prompt?.delivery
      // PTY bytes could reach any replacement menu. Structured responses target one exact item;
      // a new revision/fence/text is not a new item and must never bypass its unknown marker.
      // Why a message answer keeps its own marker: it is a message to one question, never a key a
      // later menu could take, and a stray paste is held back by its unresolved-draft mark.
      quarantineKey =
        delivery?.kind === 'structured'
          ? structuredAnswerQuarantineKey(delivery.sessionId, delivery.itemId)
          : delivery?.kind === 'message'
            ? asyncQuestionAnswerQuarantineKey(key, delivery.askedAt, prompt!.subject)
            : key
      const previous = messageMarkerByPane.get(key)
      if (delivery?.kind === 'message' && previous && previous !== quarantineKey) {
        // Why: the one open question Codex shows now is another asking, so the earlier is gone.
        quarantine.delete(previous)
        messageMarkerByPane.delete(key)
      }
    },
    get uncertain() {
      return pending()
    },
    admit() {
      if (pending()) {
        throw new SessionManageRefusal(
          'An earlier answer to this same prompt may already have reached it, and its outcome is unknown. Inspect the session and answer it there. Nothing was sent.'
        )
      }
    },
    markUncertain(evidence) {
      quarantine.add(quarantineKey, evidence)
      if (quarantineKey.startsWith(ASYNC_QUESTION_MARKER)) {
        messageMarkerByPane.set(key, quarantineKey)
      }
    },
    leftPrompt() {
      quarantine.delete(quarantineKey)
      if (messageMarkerByPane.get(key) === quarantineKey) {
        messageMarkerByPane.delete(key)
      }
    }
  }
  try {
    return await task(lock)
  } finally {
    answering.delete(key)
  }
}
