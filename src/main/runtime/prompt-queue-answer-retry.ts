/**
 * An answer the person gave on a decision page or review (`artifact-review`, `work-delivery`) is
 * queued into the agent's conversation by the prompt queue. When its delivery is refused before
 * any byte moved, for a reason that passes on its own (another write still holds the turn, the
 * turn cannot be read yet, the conversation changed under the write), it waits and goes again
 * instead of failing for good. Anything that may have typed text never comes here: only a
 * `ConversationNotSentError` is offered, and a draft left in the input box is not a passing reason.
 */

import {
  PROMPT_QUEUE_MAX_REASON_LENGTH,
  type PromptQueueEntry,
  type PromptQueueRetry
} from '../../shared/prompt-queue-types'
import { sessionHostRetryRule } from '../../shared/session-host-refusal'
import { GUARDED_WRITE_FENCE_REVOKED } from '../pty/guarded-pty-write'
import { SessionHostDeliveryRefusedError } from '../session-host/session-host-delivery-admission'

/** The answer writers whose entries retry; every other queued prompt settles as before. */
const ANSWER_ACTORS = new Set(['artifact-review', 'work-delivery'])

/** Past this since the first refusal the answer fails unsent, and its writer decides again. */
export const PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS = 24 * 60 * 60_000
export const PROMPT_QUEUE_ANSWER_RETRY_MAX_ATTEMPTS = 150
/** 15s, 30s, 1m, 2m, 5m, then every 10m. */
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const

/** The drain's own early refusal; the pane read busy again between two readings. */
export const PROMPT_QUEUE_CONVERSATION_NOT_FREE = 'The conversation is no longer verifiably free.'

/** A decision or review answer: not the person's own prompt, nor another session's relay. */
export function isPromptQueueAnswer(entry: PromptQueueEntry): boolean {
  const by = entry.requestedBy
  return Boolean(by && !by.hostOperation && ANSWER_ACTORS.has(by.actor))
}

function passesOnItsOwn(error: unknown): boolean {
  if (error instanceof SessionHostDeliveryRefusedError) {
    const { code } = error.refusal
    // Why turn-unknown too: the transcript is read again on the next attempt, often successfully.
    return code === 'turn-unknown' || sessionHostRetryRule(code) === 'new-operation-after-observe'
  }
  const message = error instanceof Error ? error.message : ''
  return message === GUARDED_WRITE_FENCE_REVOKED || message === PROMPT_QUEUE_CONVERSATION_NOT_FREE
}

/**
 * The retry schedule for an answer whose attempt sent nothing, or null when it must settle as
 * failed. The caller passes only errors that prove nothing was written.
 */
export function promptQueueAnswerRetry(
  entry: PromptQueueEntry,
  error: unknown,
  now: number
): PromptQueueRetry | null {
  if (!isPromptQueueAnswer(entry) || !passesOnItsOwn(error)) {
    return null
  }
  const attempts = (entry.retry?.attempts ?? 0) + 1
  const firstAt = entry.retry?.firstAt ?? now
  if (
    attempts > PROMPT_QUEUE_ANSWER_RETRY_MAX_ATTEMPTS ||
    now - firstAt >= PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS
  ) {
    return null
  }
  const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!
  const reason =
    error instanceof Error ? error.message.slice(0, PROMPT_QUEUE_MAX_REASON_LENGTH) : ''
  return { attempts, firstAt, notBefore: now + wait, ...(reason ? { reason } : {}) }
}
