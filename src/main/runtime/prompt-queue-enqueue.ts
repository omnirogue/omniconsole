import type { ConversationSource } from '../../shared/conversation-source'
import {
  promptQueueTextRefusal,
  type PromptQueue,
  type PromptQueueEnqueueInput
} from '../../shared/prompt-queue-types'
import type { OrcaRuntimeService } from './omni-runtime'

/**
 * The ONE way a person's own prompt enters a conversation's queue: the `promptQueue.enqueue`
 * method and an accepted next-step suggestion both land here. Throws the refusal in plain words
 * (empty, too long, queue full); an id already queued is a no-op, so a repeated click queues once.
 */
export function enqueueConversationPrompt(
  runtime: Pick<OrcaRuntimeService, 'enqueuePromptQueueEntry'>,
  source: ConversationSource,
  input: PromptQueueEnqueueInput,
  now: number = Date.now()
): PromptQueue {
  const refusal = promptQueueTextRefusal(input.text)
  if (refusal) {
    throw new Error(refusal)
  }
  return runtime.enqueuePromptQueueEntry(source, {
    id: input.id,
    text: input.text,
    createdAt: now,
    state: 'queued',
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    ...(input.automation ? { automation: input.automation } : {})
  })
}
