import { describe, expect, it } from 'vitest'
import {
  WORK_DELIVERY_CONVERSATION_MOVED,
  workDeliveryConversationGuard
} from './work-delivery-conversation-guard'

describe('work-delivery conversation guard', () => {
  it('lets the write go only while the pane still runs the target conversation', async () => {
    let current = [{ key: 'session_id' as const, id: 'CONV-1' }]
    const guard = workDeliveryConversationGuard(
      { getReportedProviderSessionsForPane: () => current },
      'tab-1:leaf-1',
      'claude:conv-1@local'
    )
    expect(guard.conversationStill()).toBe(true)
    await expect(guard.conversationGuard()).resolves.toBeNull()
    // the pane was reused by another conversation between the check and the write
    current = [{ key: 'session_id' as const, id: 'conv-2' }]
    expect(guard.conversationStill()).toBe(false)
    await expect(guard.conversationGuard()).resolves.toBe(WORK_DELIVERY_CONVERSATION_MOVED)
    current = []
    expect(guard.conversationStill()).toBe(false)
  })

  it('accepts the transcript the reference names when the hook id differs', () => {
    const guard = workDeliveryConversationGuard(
      {
        getReportedProviderSessionsForPane: () => [
          { key: 'session_id' as const, id: 'hook-id', transcriptPath: '/p/conv-1.jsonl' }
        ]
      },
      'tab-1:leaf-1',
      'claude:conv-1@local'
    )
    expect(guard.conversationStill()).toBe(true)
  })
})
