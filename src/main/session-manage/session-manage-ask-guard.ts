import type { SessionPromptBinding } from '../runtime/session-prompt-binding'
import type { SessionDeliveryDeps, SessionDeliveryTarget } from './session-manage-deliver'
import { SessionManageRefusal } from './session-manage-refusal'

/** A busy recipient may finish a turn while waiting; changing conversations revokes the question. */
export function questionConversationGuard(
  deps: SessionDeliveryDeps,
  target: SessionDeliveryTarget,
  requireKeepGoingOff: boolean
): Required<Pick<SessionPromptBinding, 'conversationGuard' | 'conversationStill'>> {
  const source = target.source!
  const expected = source.kind === 'pty' ? target.entry.providerSessionId : null
  const refusal = (): string | null => {
    if (expected && deps.providerSessionId?.(source) !== expected) {
      return 'The recipient provider conversation changed or cannot be verified; the question was not sent.'
    }
    if (requireKeepGoingOff && deps.keepGoingOn?.(source) !== false) {
      return 'Recipient Keep going is on or cannot be verified; this question will not turn it off. Nothing was sent.'
    }
    return null
  }
  const initial = refusal()
  if (initial) {
    throw new SessionManageRefusal(initial)
  }
  return {
    conversationGuard: async () => refusal(),
    conversationStill: () => refusal() === null
  }
}

/** Rechecked synchronously at the stop/queue boundary, including after unattended admission. */
export function requireKeepGoingOff(deps: SessionDeliveryDeps): SessionDeliveryDeps {
  return {
    ...deps,
    stopKeepGoing: (source) => {
      if (deps.keepGoingOn?.(source) !== false) {
        throw new SessionManageRefusal(
          'Recipient Keep going is on or cannot be verified; this question will not turn it off. Nothing was sent.'
        )
      }
      return false
    }
  }
}
