/**
 * A prompt to a conversation's own agent, sent NOW rather than at the queue's turn.
 *
 * It is the prompt queue's own record and the person's own send door, in the drain's order: the
 * entry is admitted as `sending` under this process's epoch and flushed BEFORE the bytes move,
 * which is what lets a restart tell "already sent" from "never sent" — the drain settles a foreign
 * `sending` as unconfirmed and never sends it again. It does not wait for the agent: the caller
 * decides when it may speak (Up next's "send now" interrupts; a reviewer's notes wait for the turn
 * to end). An entry already in the queue under `entry.id` is sent as it is, never enqueued twice.
 * It refuses while another entry of this queue is in flight, and holds the queue behind itself
 * exactly as a drained delivery does, so the next queued prompt waits for the agent to take it up.
 */

import { randomUUID } from 'node:crypto'
import {
  conversationDeliveryOperationId,
  conversationSourceRowKey,
  type ConversationSource
} from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import { deliverToConversation } from './conversation-delivery'
import { ConversationNotSentError } from './conversation-delivery-not-sent'
import { observeConversationReadiness } from './conversation-readiness'
import type { OrcaRuntimeService } from './omni-runtime'
import { holdPromptQueueAfterDelivery } from './prompt-queue-drain'
import { paneAgentRefusal, readPaneAgentPresence } from './prompt-queue-agent-presence'

export type ConversationPromptNowResult = {
  /** The queue's record of the send, as it was settled. */
  entry: PromptQueueEntry | undefined
  /** The door refused before any byte moved: sending again cannot deliver it twice. */
  notSent: boolean
}

export async function sendConversationPromptNow(
  runtime: OrcaRuntimeService,
  conversation: ConversationSource,
  entry: { id: string; text: string },
  epoch: string
): Promise<ConversationPromptNowResult> {
  const rowKey = conversationSourceRowKey(conversation)
  // Why before the enqueue: the hold compares against the turn that ended before this write.
  const before = await observeConversationReadiness(runtime, conversation).catch(() => null)
  const queued = () => runtime.readPromptQueue(rowKey)?.entries.find((row) => row.id === entry.id)
  if (!queued()) {
    runtime.enqueuePromptQueueEntry(conversation, {
      id: entry.id,
      text: entry.text,
      createdAt: Date.now(),
      state: 'queued'
    })
  }
  const operationId = conversationDeliveryOperationId('up-next', randomUUID())
  runtime.markPromptQueueEntrySendingAndFlush(rowKey, entry.id, {
    operationId,
    deliveryEpoch: epoch
  })
  let notSent = false
  try {
    // Same rule as the drain: never typed into the shell an exited agent left behind.
    const presence = await readPaneAgentPresence(runtime, conversation)
    const delivery = await deliverToConversation(runtime, conversation, entry.text, {
      operationId,
      conversationGuard: () => paneAgentRefusal(runtime, presence)
    })
    runtime.settlePromptQueueEntry(rowKey, entry.id, {
      state: 'delivered',
      deliveredAt: delivery.deliveredAt,
      door: delivery.door
    })
    holdPromptQueueAfterDelivery(runtime, rowKey, before?.version)
  } catch (error) {
    notSent = error instanceof ConversationNotSentError
    runtime.settlePromptQueueEntry(rowKey, entry.id, {
      state: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      ...(notSent ? { unsent: true as const } : {})
    })
  }
  return { entry: queued(), notSent }
}
