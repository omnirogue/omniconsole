import { describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { sessionPromptBinding } from '../runtime/session-prompt-binding'
import { WORK_DELIVERY_CONVERSATION_MOVED } from './work-delivery-conversation-guard'
import { runtimeWorkDeliveryDeps } from './work-delivery-runtime'

vi.mock('../artifacts/artifact-review-wake-runtime', () => ({
  runtimeReviewRowReader: () => ({
    readRows: async () => [],
    observe: vi.fn(),
    windowAttached: () => true
  })
}))

const PANE = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'wt',
  tabId: 'tab-1',
  archived: false,
  title: 'x'
}
const PROOF = {
  ptyId: 'pty-1',
  incarnationId: null,
  rootPid: 10,
  pid: 11,
  pgid: 10,
  startTimeMs: 1,
  agent: 'claude',
  via: 'hook-report' as const
}

function deps(session: { id: string }) {
  const runtime = {
    resolveTerminalPane: () => ({ handle: 'term-1' }),
    readTerminalProcessEvidence: async () => ({ proof: PROOF, tree: { kind: 'other' } }),
    readPromptQueue: () => null,
    removePromptQueueEntry: vi.fn(),
    enqueuePromptQueueEntry: vi.fn(() => ({})),
    getReportedProviderSessionsForPane: () => [{ key: 'session_id', ...session }]
  }
  return runtimeWorkDeliveryDeps({
    runtime: runtime as never,
    userDataPath: '/tmp/unused',
    api: {} as never,
    hostLabel: 'Mac',
    adapters: new Map()
  })
}

describe('typed work delivery with a conversation guard', () => {
  it('binds the guard only when asked, so the queued write refuses a reused pane', async () => {
    const session = { id: 'conv-1' }
    const typed = deps(session)
    const target = { ref: 'claude:conv-1@local', transcript: 'present' as const }
    const rowKey = conversationSourceRowKey(PANE)
    expect(await typed.enqueue(PANE, target, 'wd-a', 'answer')).toBe(true)
    expect(sessionPromptBinding(rowKey, 'wd-a')?.conversationGuard).toBeUndefined()

    expect(
      await typed.enqueue(PANE, target, 'wd-b', 'answer', undefined, { guardConversation: true })
    ).toBe(true)
    const binding = sessionPromptBinding(rowKey, 'wd-b')!
    expect(binding.receiver).toEqual(PROOF)
    await expect(binding.conversationGuard!()).resolves.toBeNull()
    session.id = 'conv-2'
    expect(binding.conversationStill!()).toBe(false)
    await expect(binding.conversationGuard!()).resolves.toBe(WORK_DELIVERY_CONVERSATION_MOVED)
  })
})
