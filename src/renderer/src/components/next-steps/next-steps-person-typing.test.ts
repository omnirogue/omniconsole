import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextStepKeepGoingState } from '../../../../shared/next-step-keep-going'
import { conversationSourceRowKey } from '../../../../shared/conversation-source'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  RuntimeRpcCallError: class extends Error {}
}))

import { notePersonTypingInConversation } from './next-steps-person-typing'
import { usePendingNextSteps } from './next-steps-pending-store'

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const running: NextStepKeepGoingState = {
  conversation,
  enabled: true,
  maxRounds: 10,
  roundsUsed: 1,
  startedAt: 5
}

beforeEach(() => {
  mocks.rpc.mockImplementation((_target: unknown, _method: string, params: { reason?: string }) =>
    Promise.resolve({
      state: { ...running, enabled: false, stopReason: params.reason, stoppedAt: 9 }
    })
  )
  usePendingNextSteps.setState({
    keepGoing: new Map([[conversationSourceRowKey(conversation), running]])
  })
})
afterEach(() => vi.clearAllMocks())

it('stops Keep going on the host once for a typing burst, and never for another pane', async () => {
  notePersonTypingInConversation('tab-9:other')
  expect(mocks.rpc).not.toHaveBeenCalled()
  notePersonTypingInConversation(conversation.paneKey)
  notePersonTypingInConversation(conversation.paneKey)
  notePersonTypingInConversation(conversation.paneKey)
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
  expect(mocks.rpc.mock.calls[0]![2]).toEqual({
    conversation,
    enabled: false,
    reason: 'person-typing'
  })
  await vi.waitFor(() =>
    expect(
      usePendingNextSteps.getState().keepGoing.get(conversationSourceRowKey(conversation))
    ).toMatchObject({ enabled: false, stopReason: 'person-typing' })
  )
})

it('does nothing while Keep going is off', () => {
  usePendingNextSteps.setState({ keepGoing: new Map() })
  notePersonTypingInConversation(conversation.paneKey)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
