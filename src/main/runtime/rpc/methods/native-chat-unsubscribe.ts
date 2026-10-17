import { z } from 'zod'
import { defineMethod } from '../core'

const NativeChatUnsubscribe = z.object({ subscriptionId: z.string().min(1).optional() })

export const NATIVE_CHAT_UNSUBSCRIBE = defineMethod({
  name: 'nativeChat.unsubscribe',
  params: NativeChatUnsubscribe,
  handler: async (params, { runtime, connectionId }) => {
    const connection = connectionId ?? 'local'
    if (params.subscriptionId) {
      runtime.cleanupSubscription(`nativeChat:${connection}:${params.subscriptionId}`)
      return { unsubscribed: true }
    }
    runtime.cleanupSubscriptionsByPrefix(`nativeChat:${connection}:`)
    return { unsubscribed: true }
  }
})
