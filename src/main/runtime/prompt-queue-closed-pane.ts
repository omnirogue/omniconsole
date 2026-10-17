/**
 * A decision or review answer (`prompt-queue-answer-retry.ts`) queued to a pane that is then
 * closed never reads free, so the drain would hold it `queued` for ever and its writer (the
 * answer-delivery claimer, the review pass) would never get to resume or wake the session
 * somewhere else. Once the pane is definitely gone from this computer, read gone on two drains at
 * least a minute apart, every answer still waiting in its queue settles failed and unsent: not a
 * byte of it was written. A busy, unreadable or not yet restored pane, the person's own prompts
 * and anything already sending are left as they were.
 *
 * The same holds for an answer whose retry day ran out while its pane stayed busy or unreadable:
 * the retry rule only ends it on a refused attempt, and a pane that never reads free refuses none.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { PromptQueue, PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  isPromptQueueAnswer,
  PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS
} from './prompt-queue-answer-retry'
import { releaseSessionPrompt } from './session-prompt-binding'

export const PROMPT_QUEUE_PANE_CLOSED =
  'Its session pane was closed before this answer could be typed; it was not sent.'

export const PROMPT_QUEUE_ANSWER_RETRY_EXPIRED =
  'Its session was not free to take this answer for a day; it was not sent.'

/** A closed pane must still read closed this long after it was first seen closed. */
export const PROMPT_QUEUE_PANE_CLOSED_CONFIRM_MS = 60_000

type ClosedPaneRuntime = Pick<
  OrcaRuntimeService,
  'isTerminalPaneClosedHere' | 'settlePromptQueueEntry'
>

/** First drain that read each queue's pane closed, by row key; in memory only. */
const firstSeenClosed = new Map<string, number>()

function paneClosedHere(runtime: ClosedPaneRuntime, source: ConversationSource): boolean {
  // Why PTY only: a chat session has no saved pane record that can prove it is gone.
  if (source.kind !== 'pty') {
    return false
  }
  try {
    return runtime.isTerminalPaneClosedHere(source.paneKey, source.worktreeId) === true
  } catch {
    return false
  }
}

function settleUnsent(
  runtime: ClosedPaneRuntime,
  rowKey: string,
  entry: PromptQueueEntry,
  reason: string
): void {
  releaseSessionPrompt(rowKey, entry.id)
  runtime.settlePromptQueueEntry(rowKey, entry.id, { state: 'failed', reason, unsent: true })
}

/**
 * Settles every answer still waiting in the queue once its pane is closed for good. True when it
 * did; the drain then leaves this queue for this tick.
 */
export function settleAnswersForClosedPane(
  runtime: ClosedPaneRuntime,
  rowKey: string,
  queue: PromptQueue,
  now: number
): boolean {
  const waiting = queue.entries.filter(
    (entry) => entry.state === 'queued' && isPromptQueueAnswer(entry)
  )
  if (!waiting.length || !paneClosedHere(runtime, queue.source)) {
    firstSeenClosed.delete(rowKey)
    return false
  }
  const first = firstSeenClosed.get(rowKey)
  if (first === undefined) {
    firstSeenClosed.set(rowKey, now)
    return false
  }
  if (now - first < PROMPT_QUEUE_PANE_CLOSED_CONFIRM_MS) {
    return false
  }
  firstSeenClosed.delete(rowKey)
  for (const entry of waiting) {
    settleUnsent(runtime, rowKey, entry, PROMPT_QUEUE_PANE_CLOSED)
  }
  return true
}

/** Settles a waiting answer whose retry day has run out while its pane is not free; true if so. */
export function settleAnswerPastRetryDay(
  runtime: ClosedPaneRuntime,
  rowKey: string,
  entry: PromptQueueEntry,
  now: number
): boolean {
  if (
    entry.state !== 'queued' ||
    !isPromptQueueAnswer(entry) ||
    !entry.retry ||
    now - entry.retry.firstAt < PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS
  ) {
    return false
  }
  settleUnsent(runtime, rowKey, entry, PROMPT_QUEUE_ANSWER_RETRY_EXPIRED)
  return true
}
