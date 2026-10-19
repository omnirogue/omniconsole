import type { ConversationSource } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import { getDeliverableVerifier } from '../deliverable-verifier/deliverable-verifier-slot'
import { getNextStepKeepGoingController } from '../next-steps/next-step-suggestion-slot'
import { assertCapacityRecoveryDelivery } from './conversation-capacity-recovery-delivery'
import { isChainBoundToConversation } from './conversation-chain-ownership'
import type { OrcaRuntimeService } from './omni-runtime'
import { sessionContextQueueRefusal } from './prompt-queue-context-identity'

/** Re-read receiver and continuation ownership before each write, including Enter. */
export function assertPromptQueueEntryDelivery(
  runtime: OrcaRuntimeService,
  rowKey: string,
  source: ConversationSource,
  entry: PromptQueueEntry
): void {
  if (isChainBoundToConversation(runtime, source)) {
    throw new Error('A live plan now owns this conversation, so the queued prompt was not sent.')
  }
  assertCapacityRecoveryDelivery(runtime, source, entry.id)
  if (entry.origin?.kind === 'session-context') {
    const refusal = sessionContextQueueRefusal(runtime, source, entry.origin.identity)
    if (refusal) {
      throw new Error(refusal)
    }
  }
  if (entry.origin?.kind === 'keep-going') {
    const controller = getNextStepKeepGoingController()
    const current = runtime
      .readPromptQueue(rowKey)
      ?.entries.find((candidate) => candidate.id === entry.id)
    if (!controller || !current) {
      throw new Error('Keep going is not running, so its automatic prompt was not sent.')
    }
    controller.assertDelivery(source, current)
  }
  if (entry.automation?.kind === 'deliverable-repair') {
    const verifier = getDeliverableVerifier()
    const current = runtime
      .readPromptQueue(rowKey)
      ?.entries.find((candidate) => candidate.id === entry.id)
    if (!verifier || !current) {
      throw new Error('The deliverable check is not running, so its prompt was not sent.')
    }
    verifier.assertDelivery(source, current)
  }
}
