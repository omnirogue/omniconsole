import { useEffect, useState } from 'react'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import { readCurrentNextSteps } from './next-steps-client'

/**
 * True once the host confirms it has observed no turn in this conversation — the same "empty"
 * the chat views read from their transcript. Unknown (not asked, or the read failed) is false.
 */
export function useHostSeesNoTurn(conversation: ConversationSource | null): boolean {
  const key = conversation ? conversationSourceRowKey(conversation) : null
  const [confirmed, setConfirmed] = useState<string | null>(null)
  useEffect(() => {
    if (!conversation || !key) {
      return
    }
    let cancelled = false
    readCurrentNextSteps(conversation).then(
      (current) => {
        if (!cancelled && current.turnObserved === false) {
          setConfirmed(key)
        }
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [conversation, key])
  return key !== null && confirmed === key
}
