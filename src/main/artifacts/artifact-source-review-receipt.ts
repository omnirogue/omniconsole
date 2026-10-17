/**
 * The review pass records `queued` on a decision's receipt when its prompt-queue entry is queued,
 * and nothing moved it on after that entry settled, so a failed send still read "queued". Each
 * pass now copies a settled entry's ending onto its receipt: `delivered`, or `failed` with whether
 * it was proven unsent. Once settled the receipt is never written again.
 */

import {
  PROMPT_QUEUE_MAX_REASON_LENGTH,
  type PromptQueueEntry,
  type PromptQueues
} from '../../shared/prompt-queue-types'
import type { ArtifactSourceReview } from './artifact-source-review'
import type { SourceReviewEntry } from './artifact-source-review-watch'

type SourceReceipt = NonNullable<ArtifactSourceReview['receipt']>

export type SourceReviewReceiptDeps = {
  entries(): SourceReviewEntry[]
  /** The prompt-queue entry with this id in any of this computer's queues (the pane may move). */
  find(entryId: string): PromptQueueEntry | undefined
  save(entry: SourceReviewEntry, receipt: SourceReceipt): boolean
}

/** The receipt a settled entry earns, or null while it is still waiting or sending. */
export function settledSourceReviewReceipt(
  receipt: SourceReceipt,
  queued: PromptQueueEntry | undefined
): SourceReceipt | null {
  if (receipt.status !== 'queued' || receipt.transport === 'codex-queue') {
    return null
  }
  if (queued?.state === 'delivered') {
    return { ...receipt, status: 'delivered' }
  }
  if (queued?.state === 'failed') {
    const reason = queued.reason?.slice(0, PROMPT_QUEUE_MAX_REASON_LENGTH)
    return {
      ...receipt,
      status: 'failed',
      ...(queued.unsent ? { unsent: true as const } : {}),
      ...(reason ? { reason } : {})
    }
  }
  return null
}

/** Moves every `queued` receipt whose entry settled to that ending; the number it moved. */
export function reconcileSourceReviewReceipts(deps: SourceReviewReceiptDeps): number {
  let moved = 0
  for (const entry of deps.entries()) {
    const receipt = entry.sourceReview.receipt
    const next = receipt && settledSourceReviewReceipt(receipt, deps.find(receipt.entryId))
    if (next && deps.save(entry, next)) {
      moved += 1
    }
  }
  return moved
}

/** Looks an entry up by id across every queue on this computer. */
export function findPromptQueueEntry(
  queues: PromptQueues,
  entryId: string
): PromptQueueEntry | undefined {
  for (const queue of Object.values(queues)) {
    const found = queue.entries.find((candidate) => candidate.id === entryId)
    if (found) {
      return found
    }
  }
  return undefined
}
