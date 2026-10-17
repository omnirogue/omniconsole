/**
 * The review pass's wake guards, for the answer-delivery claimer: before the claimer reopens a
 * session a review wait put to sleep, the same checks `prepareReviewWake` makes run here, so a
 * decision never wakes a second copy (another computer's wake copy, a wake still starting, a
 * stalled one that started a terminal). The wait is then marked `waking` without its copy, so no
 * other computer can take it while the claimer reopens it.
 */

import { wakeCopyMayExist, type ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { REVIEW_WAKE_SETTLE_MS, type ReviewWakeDeps } from '../artifacts/artifact-review-wake'
import type { SourceReviewEntry } from '../artifacts/artifact-source-review-watch'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { queueEntryState, type QueueEntryState } from '../work-delivery/work-delivery-claimer-types'
import type { WorkDeliveryHeldReason } from '../work-delivery/work-delivery-kind'

export type ReviewGateDeps = Pick<
  ReviewWakeDeps,
  'wakeClaimElsewhere' | 'withdrawWakeCopy' | 'saveSleep' | 'now'
>

export type ReviewHold = { go: false; reason: WorkDeliveryHeldReason; message: string }
export type ReviewGate = { go: true } | ReviewHold

const RESUMABLE = new Set(['asleep', 'waking', 'stalled'])

/** The `reason` a wake the claimer started carries; a retry of the same answer may go on. */
export function answerWakeReason(deliveryKey: string): string {
  return `Woken by the answer delivery ${deliveryKey}.`
}

const hold = (reason: WorkDeliveryHeldReason, message: string): ReviewHold => ({
  go: false,
  reason,
  message
})

/** The share record's last send for this decision, by the review pass: never sent again. */
export function reviewPassSent(entry: SourceReviewEntry, decisionId: unknown): boolean {
  const receipt = entry.sourceReview.receipt
  return (
    decisionId !== undefined &&
    decisionId !== null &&
    receipt?.decisionId === String(decisionId) &&
    receipt.status !== 'prepared'
  )
}

/** The review pass's prompt-queue entries on this computer, by id. */
export type ReviewPassQueue = {
  state(entryId: string): QueueEntryState
  /** Settles a still-queued entry as unsent in one tick; false once it moved on. */
  withdraw(entryId: string): boolean
}

/** The review pass's entries in any of this computer's prompt queues (the pane may have moved). */
export function runtimeReviewPassQueue(
  runtime: Pick<OrcaRuntimeService, 'listPromptQueues' | 'settlePromptQueueEntry'>
): ReviewPassQueue {
  const find = (entryId: string) => {
    for (const queue of Object.values(runtime.listPromptQueues())) {
      const entry = queue.entries.find((candidate) => candidate.id === entryId)
      if (entry) {
        return { rowKey: conversationSourceRowKey(queue.source), entry }
      }
    }
    return null
  }
  return {
    state: (entryId) => queueEntryState(find(entryId)?.entry),
    withdraw: (entryId) => {
      // Read and settle in one tick: the drain cannot take it between the two.
      const found = find(entryId)
      if (found?.entry.state !== 'queued') {
        return false
      }
      runtime.settlePromptQueueEntry(found.rowKey, entryId, {
        state: 'failed',
        reason: 'Its session is not open here; the answer delivery sends this decision instead.',
        unsent: true
      })
      return true
    }
  }
}

/**
 * What the claimer does with a decision the review pass may have sent: `unsent` goes the normal
 * way, `follow` is followed in the live pane, and one that may have reached the agent is held.
 */
export async function reviewPassOutcome(
  entry: SourceReviewEntry,
  decisionId: unknown,
  queue: ReviewPassQueue,
  liveHere: () => Promise<boolean>
): Promise<'unsent' | 'follow' | ReviewHold> {
  const receipt = entry.sourceReview.receipt
  if (!receipt || !reviewPassSent(entry, decisionId)) {
    return 'unsent'
  }
  // Why: only the prompt queue proves a send never left; a Codex native queue cannot.
  const state = receipt.transport === 'codex-queue' ? 'missing' : queue.state(receipt.entryId)
  if (state === 'failed-unsent') {
    return 'unsent'
  }
  if (await liveHere()) {
    return 'follow'
  }
  if (state === 'queued') {
    // Why withdrawn: settled unsent, the drain cannot send it after the claimer does.
    return queue.withdraw(receipt.entryId)
      ? 'unsent'
      : hold('busy', 'The review path is sending this decision now; it is checked again shortly.')
  }
  return hold(
    'unverifiable',
    'The review path on this computer already sent this decision, so it is not sent a second time.'
  )
}

export async function reviewWakeGate(
  deps: ReviewGateDeps,
  entry: SourceReviewEntry,
  sleep: ArtifactReviewSleep | undefined,
  deliveryKey: string
): Promise<ReviewGate> {
  if (!sleep || sleep.revision !== entry.sourceReview.revision) {
    return { go: true }
  }
  if (sleep.state === 'deleted') {
    return hold('protection', 'The session was deleted when this page was rejected.')
  }
  if (sleep.state === 'moved') {
    return hold('unverifiable', sleep.reason ?? 'It moved to another computer.')
  }
  if (!RESUMABLE.has(sleep.state)) {
    return { go: true }
  }
  // Why first: a copy another computer woke from is that computer's now.
  const elsewhere = await deps.wakeClaimElsewhere(entry, sleep)
  if (elsewhere) {
    return hold('unverifiable', elsewhere)
  }
  const ours = answerWakeReason(deliveryKey)
  const now = deps.now()
  if (sleep.state === 'waking' && sleep.reason !== ours && now - sleep.at < REVIEW_WAKE_SETTLE_MS) {
    return hold('busy', 'The woken conversation is still starting.')
  }
  if (sleep.state === 'stalled' && sleep.retryAfter === undefined) {
    // Why never retried: its wake started a terminal, and a second launch could run it twice.
    return hold('unverifiable', sleep.reason ?? 'Its wake stalled after it started.')
  }
  if (sleep.state === 'stalled' && now < sleep.retryAfter!) {
    return hold('busy', sleep.reason ?? 'Its wake stalled; it is tried again shortly.')
  }
  if (wakeCopyMayExist(sleep)) {
    const withdrawn = await deps.withdrawWakeCopy(entry)
    if (withdrawn !== 'ok') {
      return withdrawn === 'claimed'
        ? hold('unverifiable', 'Another computer took it first.')
        : hold('error', 'Its copy on OmniOS could not be withdrawn yet.')
    }
  }
  if (sleep.state === 'waking' && sleep.reason === ours && !sleep.wakeCopy) {
    return { go: true }
  }
  const { wakeCopy: _withdrawn, retryAfter: _retryAfter, ...rest } = sleep
  if (!deps.saveSleep(entry, { ...rest, state: 'waking', at: now, reason: ours })) {
    return hold('error', 'Its share record changed; it is read again.')
  }
  return { go: true }
}
