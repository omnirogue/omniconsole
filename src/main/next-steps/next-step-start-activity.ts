/**
 * Signs that a person has already used a conversation: a turn that started, finished or was
 * skipped. Suggested starts read "fresh" only where none was ever seen in this process.
 */

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import type { TurnSignal } from './next-step-turn-signal'

const active = new WeakMap<NextStepSuggestionService, Set<string>>()

/** Records the conversation behind any turn signal: busy, finished or skipped. */
export function noteNextStepStartActivity(
  service: NextStepSuggestionService,
  signal: TurnSignal
): void {
  const conversation =
    signal.kind === 'finished'
      ? signal.turn.conversation
      : signal.kind === 'busy' || signal.kind === 'skip'
        ? signal.conversation
        : undefined
  if (!conversation) {
    return
  }
  let keys = active.get(service)
  if (!keys) {
    keys = new Set()
    active.set(service, keys)
  }
  keys.add(conversationSourceRowKey(conversation))
}

export function hasNextStepStartActivity(service: NextStepSuggestionService, key: string): boolean {
  return active.get(service)?.has(key) ?? false
}
