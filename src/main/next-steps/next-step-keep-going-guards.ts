/**
 * The checks "Keep going" makes before and between rounds. Each answers "stop, and why" or null;
 * anything it cannot read counts as a reason to stop.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { NextStepSuggestionService } from './next-step-suggestion-service'

/** Why the agent cannot take a next step by itself right now. */
export type NextStepKeepGoingAttention = 'agent-waiting' | 'turn-failed'

// Why not held: a held handoff is waiting on the person too.
const SETTLED_RECOVERY_PHASES = new Set(['delivered', 'cancelled'])

/**
 * The stops that can happen at any moment, not only at a turn: suggestions turned off, a plan,
 * capacity recovery, anything in the queue this round did not put there, an open question.
 */
export function keepGoingGuardRefusal(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  ownEntryId: string | undefined,
  attention: NextStepKeepGoingAttention | null
): NextStepKeepGoingStopReason | null {
  const { deps } = service
  if (!deps.settings().enabled) {
    return 'setting-off'
  }
  if (deps.isChainBound(conversation)) {
    return 'chain-bound'
  }
  const queue: PromptQueue | null = deps.readPromptQueue(conversation)
  if (queue?.recovery && !SETTLED_RECOVERY_PHASES.has(queue.recovery.phase)) {
    return 'capacity-recovery'
  }
  const foreign = queue?.entries.some(
    (entry) => (entry.state === 'queued' || entry.state === 'sending') && entry.id !== ownEntryId
  )
  if (foreign) {
    return 'person-message'
  }
  return attention
}
