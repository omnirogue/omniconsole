import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { deriveNativeChatSessionOptionParityHold } from './native-chat-send-eligibility'
import type { useChatTagComposer } from './use-chat-tag-composer'

/**
 * The composer field's delivery-aware state. `sessionOptions` is the live option
 * snapshot: while it reports the session is not running the model or effort that was
 * requested, the AGENT send is held (deriveNativeChatSessionOptionParityHold) until
 * the person re-picks or keeps what the provider reported. A chat delivery to a person
 * or another agent is not that turn, so tag mode is never held by it — and nothing
 * else about the composer is disabled either.
 */
export function chatTagFieldState(
  tags: ReturnType<typeof useChatTagComposer>,
  disabled: boolean,
  sendButtonDisabled: boolean,
  isWorking: boolean,
  sessionOptions: readonly SessionOptionDescriptor[] = []
) {
  const parityHold = deriveNativeChatSessionOptionParityHold(sessionOptions)
  return {
    disabled: tags.active || tags.tagging ? tags.pending || tags.retrySaved : disabled,
    onTag: tags.beginTag,
    directDelivery: tags.active,
    tagDisabled: tags.pending || tags.retrySaved || tags.attaching,
    deliveryBar: tags.bar,
    deliveryStatus: tags.status,
    mentionPicker: tags.picker,
    mentionOptionCount: tags.optionCount,
    sendLabel: tags.sendLabel,
    sendButtonDisabled:
      tags.blocked ||
      tags.tagging ||
      (tags.active
        ? tags.pending || tags.attaching || !tags.hasContent
        : sendButtonDisabled || parityHold),
    isWorking: tags.active ? false : isWorking,
    attachDisabled: tags.active ? tags.pending || tags.retrySaved || tags.attaching : disabled
  }
}
