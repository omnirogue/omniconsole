/**
 * The last word before a repair prompt's bytes move: the owning host re-reads its own record and
 * the conversation, and any doubt refuses. Also what tells the steward a repair is in flight.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { DeliverableVerifierSettings } from '../../shared/deliverable-verifier-settings'
import type { PromptQueue, PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { DeliverableVerificationStore } from './deliverable-verification-store'

export const DELIVERABLE_ACTIVE_QUEUE_STATES: ReadonlySet<string> = new Set(['queued', 'sending'])

export type DeliverableDeliveryReaders = {
  settings: () => DeliverableVerifierSettings
  store: DeliverableVerificationStore
  isKeepGoingOn: (source: ConversationSource) => boolean
  agentWaiting: (source: ConversationSource) => boolean
  pendingQuestion: (paneKey: string) => boolean
  readQueue: (source: ConversationSource) => PromptQueue | null
}

export function queuedDeliverableRepair(queue: PromptQueue | null): boolean {
  return (queue?.entries ?? []).some(
    (entry) =>
      entry.automation?.kind === 'deliverable-repair' &&
      DELIVERABLE_ACTIVE_QUEUE_STATES.has(entry.state)
  )
}

/** Why this repair must not be written now, or null when it may. */
export function deliverableRepairDeliveryRefusal(
  readers: DeliverableDeliveryReaders,
  source: ConversationSource,
  entry: PromptQueueEntry
): string | null {
  if (readers.settings().mode !== 'on') {
    return 'The deliverable check is not set to ask agents to finish, so its prompt was not sent.'
  }
  const record = readers.store.list().findLast((candidate) => candidate.promptId === entry.id)
  if (!record || record.action !== 'repair-sent') {
    return 'This deliverable check prompt has no record on this computer, so it was not sent.'
  }
  if (readers.isKeepGoingOn(source)) {
    return 'Keep going now drives this conversation, so the deliverable check prompt was not sent.'
  }
  if (readers.agentWaiting(source) || readers.pendingQuestion(source.paneKey)) {
    return 'The agent is waiting for the person, so the deliverable check prompt was not sent.'
  }
  return deliverableQueueBusy(readers.readQueue(source), entry.id)
    ? 'Another message is waiting for this conversation, so the deliverable check prompt was not sent.'
    : null
}

/** Anything else queued or being sent — the person's, the steward's — or a failed message holding
 *  the queue: a repair never goes ahead of it, nor beside another automation's prompt. */
export function deliverableQueueBusy(queue: PromptQueue | null, ownId?: string): boolean {
  return (queue?.entries ?? []).some(
    (other) =>
      other.id !== ownId &&
      (DELIVERABLE_ACTIVE_QUEUE_STATES.has(other.state) ||
        (other.state === 'failed' && other.holdsQueue === true))
  )
}
