/**
 * The wait half of `omni session ask`: the reply is the finished turn whose recorded prompt is this
 * question: at least its whole marker, which carries the question's own request id, and a prefix of
 * exactly what was sent. Another question's turn (another id) and the person's own message are not
 * the answer and are passed over. The turn may finish while the send is still settling (`sending`).
 *
 * On timeout (or the asking client going away) a question still waiting in the queue is WITHDRAWN
 * unsent, so it never reaches the target with nobody left to read the answer; one already
 * delivered cannot be taken back, and the result says so.
 */

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { FinishedTurn, TurnSignal } from '../next-steps/next-step-turn-signal'

export const SESSION_ASK_WITHDRAWN_REASON =
  'Withdrawn unsent: the session that asked stopped waiting for the answer.'

const POLL_MS = 1_000

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The turn answered this question: its prompt carries this question's marker and id. */
export function turnAnswersQuestion(
  sent: { marker: string; sentText: string },
  entry: AskWaitEntry | undefined,
  turn: Pick<FinishedTurn, 'lastUserPrompt' | 'completedAt'>
): boolean {
  if (entry?.state !== 'sending' && entry?.state !== 'delivered') {
    return false
  }
  if (turn.completedAt !== undefined && turn.completedAt < entry.createdAt) {
    return false
  }
  const recorded = collapsed(turn.lastUserPrompt ?? '')
  return (
    recorded.length >= collapsed(sent.marker).length &&
    collapsed(sent.sentText).startsWith(recorded)
  )
}

/** A queued prompt's delivery state; a launch prompt stands in as already delivered. */
export type AskWaitEntry = Pick<PromptQueueEntry, 'state' | 'createdAt' | 'reason'>

export type AskWaitDeps = {
  subscribe(listener: (signal: TurnSignal) => void): () => void
  readEntry(): AskWaitEntry | undefined
  /** Settles the entry as failed when it is still `queued`, in the same tick; true when it did. */
  withdrawIfQueued(reason: string): boolean
  pollMs?: number
}

export type AskWaitResult =
  | { outcome: 'answered'; reply: string; turn?: FinishedTurn }
  | { outcome: 'timeout'; question: 'withdrawn' | 'delivered'; note?: string }
  | { outcome: 'failed'; reason: string }

export function waitForAskReply(
  deps: AskWaitDeps,
  input: {
    rowKey: string
    marker: string
    sentText: string
    timeoutMs: number
    /** Transfers cannot archive against a preview or clipped reply. */
    requireCompleteReply?: boolean
    onCompleteReply?: (turn: FinishedTurn) => void
    signal?: AbortSignal
  }
): Promise<AskWaitResult> {
  return new Promise((resolve) => {
    let settled = false
    let lastSkip: string | undefined
    const cleanups: (() => void)[] = []
    const finish = (result: AskWaitResult): void => {
      if (settled) {
        return
      }
      settled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
      resolve(result)
    }
    const expire = (): void => {
      const withdrawn = deps.withdrawIfQueued(SESSION_ASK_WITHDRAWN_REASON)
      finish({
        outcome: 'timeout',
        question: withdrawn ? 'withdrawn' : 'delivered',
        ...(lastSkip ? { note: lastSkip } : {})
      })
    }
    cleanups.push(
      deps.subscribe((signal) => {
        if (signal.kind === 'skip' && signal.conversation) {
          if (conversationSourceRowKey(signal.conversation) === input.rowKey) {
            lastSkip = `A turn after the question ended without a reply: ${signal.reason}`
          }
          return
        }
        if (
          signal.kind === 'finished' &&
          conversationSourceRowKey(signal.turn.conversation) === input.rowKey &&
          turnAnswersQuestion(input, deps.readEntry(), signal.turn)
        ) {
          if (input.requireCompleteReply && signal.turn.replyComplete !== true) {
            finish({ outcome: 'failed', reason: 'The matching reply could not be read in full.' })
            return
          }
          try {
            input.onCompleteReply?.(signal.turn)
          } catch (error) {
            finish({
              outcome: 'failed',
              reason: error instanceof Error ? error.message : String(error)
            })
            return
          }
          finish({
            outcome: 'answered',
            reply: signal.turn.lastAssistantMessage,
            ...(input.requireCompleteReply ? { turn: signal.turn } : {})
          })
        }
      })
    )
    const poll = setInterval(() => {
      const entry = deps.readEntry()
      if (!entry) {
        finish({
          outcome: 'failed',
          reason: 'The question left its queue before it was sent (it was removed in the app).'
        })
      } else if (entry.state === 'failed') {
        finish({
          outcome: 'failed',
          reason: entry.reason ?? 'The question could not be delivered.'
        })
      }
    }, deps.pollMs ?? POLL_MS)
    cleanups.push(() => clearInterval(poll))
    const timer = setTimeout(expire, input.timeoutMs)
    cleanups.push(() => clearTimeout(timer))
    if (input.signal) {
      if (input.signal.aborted) {
        expire()
        return
      }
      const onAbort = (): void => expire()
      input.signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => input.signal?.removeEventListener('abort', onAbort))
    }
  })
}
