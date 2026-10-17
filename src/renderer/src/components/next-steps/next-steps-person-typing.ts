import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import { setNextStepKeepGoing } from './next-steps-client'
import { noteNextStepKeepGoing, usePendingNextSteps } from './next-steps-pending-store'

// One stop per enablement: every later keystroke of the same burst is a no-op.
const stopsSent = new Set<string>()

/**
 * The person typed in a conversation, in the chat composer or the terminal, sent or not. Keep
 * going on that conversation stops on the host at once (`person-typing`), exactly once.
 */
export function notePersonTypingInConversation(paneKey: string): void {
  const running = [...usePendingNextSteps.getState().keepGoing.values()].filter(
    (state) => state.enabled && state.conversation.paneKey === paneKey
  )
  for (const state of running) {
    const once = `${conversationSourceRowKey(state.conversation)}@${state.startedAt}`
    if (stopsSent.has(once)) {
      continue
    }
    stopsSent.add(once)
    const conversation: ConversationSource = state.conversation
    setNextStepKeepGoing(conversation, false, undefined, 'person-typing').then(
      noteNextStepKeepGoing,
      // A failed stop may be tried again by the next keystroke.
      () => stopsSent.delete(once)
    )
  }
}
