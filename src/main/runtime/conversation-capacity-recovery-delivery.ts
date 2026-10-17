import { CAPACITY_RECOVERY_ENTRY_PREFIX } from '../../shared/conversation-capacity-recovery'
import {
  conversationSourceRowKey,
  conversationSourcesEqual,
  type ConversationSource
} from '../../shared/conversation-source'
import type { OrcaRuntimeService } from './omni-runtime'
import { isChainBoundToConversation } from './conversation-chain-ownership'

/** A machine handoff cannot acquire the authority of a newly typed user message. */
export function assertCapacityRecoveryDelivery(
  runtime: OrcaRuntimeService,
  target: ConversationSource,
  entryId: string
): void {
  if (!entryId.startsWith(CAPACITY_RECOVERY_ENTRY_PREFIX)) {
    return
  }
  const source = Object.values(runtime.listPromptQueues()).find(
    (queue) => queue.recovery?.id === entryId
  )
  const recovery = source?.recovery
  if (
    !source ||
    !recovery ||
    recovery.phase !== 'created' ||
    !recovery.successor?.source ||
    !conversationSourcesEqual(recovery.successor.source, target) ||
    runtime.isPtyStopRequested(recovery.sourcePtyId) ||
    runtime.hasConversationCapacityOwner(source.source) ||
    runtime.hasConversationCapacityOwner(target) ||
    isChainBoundToConversation(runtime, source.source) ||
    source.entries.some((entry) => entry.state === 'queued' || entry.state === 'sending') ||
    runtime
      .readPromptQueue(conversationSourceRowKey(target))
      ?.entries.some(
        (entry) => entry.id !== entryId && (entry.state === 'queued' || entry.state === 'sending')
      )
  ) {
    throw new Error('The automatic handoff was cancelled or superseded by newer instructions.')
  }
}
