/**
 * Keep going's hold on the prompt queue: taking its entries back out, finding ones an earlier run
 * left behind, and the delivery-time check the drain runs immediately before a write.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { PromptQueueEntry, PromptQueues } from '../../shared/prompt-queue-types'
import type { KeepGoingRound, RoundTrack } from './next-step-keep-going-rounds'

export const STOPPED_ENTRY_REASON = 'Keep going stopped before this automatic prompt was sent.'
export const STALE_ENTRY_REASON =
  'This automatic Keep going prompt was left by an earlier run and was not sent.'

export type KeepGoingQueueAccess = {
  readQueueEntry: (source: ConversationSource, entryId: string) => PromptQueueEntry | undefined
  /** Settles a still-queued entry as failed, with the reason; true when it was withdrawn. */
  withdrawQueued: (source: ConversationSource, entryId: string, reason: string) => boolean
}

export function withdrawQueuedEntry(
  access: KeepGoingQueueAccess,
  source: ConversationSource,
  entryId: string,
  reason: string
): boolean {
  return access.readQueueEntry(source, entryId)?.state === 'queued'
    ? access.withdrawQueued(source, entryId, reason)
    : false
}

/** Whether a queued entry is exactly the outstanding round of this running enablement. */
export function isOutstandingEntry(
  track: RoundTrack | undefined,
  entry: PromptQueueEntry
): track is RoundTrack & { outstanding: KeepGoingRound } {
  return (
    track?.outstanding !== undefined &&
    track.outstanding.entryId === entry.id &&
    entry.origin?.kind === 'keep-going' &&
    entry.origin.runToken === track.runToken &&
    entry.origin.round === track.outstanding.round
  )
}

/** Still-queued Keep going entries no running enablement owns: a restart's, or a stopped run's. */
export function strayKeepGoingEntries(
  queues: PromptQueues,
  trackOf: (source: ConversationSource) => RoundTrack | undefined
): { source: ConversationSource; entry: PromptQueueEntry }[] {
  return Object.values(queues).flatMap((queue) =>
    queue.entries
      .filter(
        (entry) =>
          entry.state === 'queued' &&
          entry.origin?.kind === 'keep-going' &&
          !isOutstandingEntry(trackOf(queue.source), entry)
      )
      .map((entry) => ({ source: queue.source, entry }))
  )
}

/** The delivery-time verdict for one entry, from facts read in the same tick as the write. */
export function deliveryRefusal(facts: {
  track: RoundTrack | undefined
  entry: PromptQueueEntry
  open: boolean
  currentTurnKey: string | null
  guard: NextStepKeepGoingStopReason | null
}): { reason: NextStepKeepGoingStopReason; detail?: string } | null {
  if (!isOutstandingEntry(facts.track, facts.entry)) {
    return {
      reason: 'round-refused',
      detail: 'This prompt is not the round Keep going is waiting to send.'
    }
  }
  if (!facts.open) {
    return { reason: 'pane-closed' }
  }
  if (facts.currentTurnKey === null) {
    return { reason: 'turn-unknown' }
  }
  // A turn finished since this round was queued, and it was not this round's.
  if (facts.currentTurnKey !== facts.track.outstanding.turnKey) {
    return { reason: 'person-message' }
  }
  return facts.guard ? { reason: facts.guard } : null
}
