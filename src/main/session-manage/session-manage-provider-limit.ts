import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { SessionStateFacts } from './session-manage-state'

/** The provider usage limit a conversation's queue is waiting out, or undefined when none holds it. */
export function providerLimit(queue: PromptQueue | null): SessionStateFacts['providerLimit'] {
  const recovery = queue?.recovery
  if (!recovery || recovery.phase === 'delivered' || recovery.phase === 'cancelled') {
    return undefined
  }
  return recovery.sourceResetAt ? { resetAt: recovery.sourceResetAt } : {}
}
