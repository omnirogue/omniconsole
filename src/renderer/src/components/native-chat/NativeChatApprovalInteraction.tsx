import { useLayoutEffect, useRef, useState } from 'react'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { ChatApproval } from './native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/** Keyed by the approval identity so a replacement never inherits a pending or failed send. */
export function NativeChatApprovalInteraction({
  approval,
  interactivePrompt,
  sendApproval,
  onDelivered
}: {
  approval: ChatApproval
  interactivePrompt: string | null
  sendApproval: NativeChatInteractiveSend['sendApproval']
  onDelivered: () => void
}): React.JSX.Element {
  const attemptRef = useRef<symbol | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deliveryFailed, setDeliveryFailed] = useState(false)
  useLayoutEffect(
    () => () => {
      attemptRef.current = null
    },
    []
  )
  return (
    <NativeChatApprovalCard
      approval={approval}
      isSubmitting={submitting}
      deliveryFailed={deliveryFailed}
      onChoose={(choice) => {
        if (attemptRef.current || !interactivePrompt) {
          return
        }
        const attempt = Symbol()
        attemptRef.current = attempt
        setDeliveryFailed(false)
        setSubmitting(true)
        const settle = (delivered: boolean): void => {
          if (attemptRef.current !== attempt) {
            return
          }
          attemptRef.current = null
          setSubmitting(false)
          setDeliveryFailed(!delivered)
          if (delivered) {
            onDelivered()
          }
        }
        if (!sendApproval(interactivePrompt, choice, settle)) {
          settle(false)
        }
      }}
    />
  )
}
