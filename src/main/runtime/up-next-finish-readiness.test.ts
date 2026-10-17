import { beforeEach, expect, it, vi } from 'vitest'
import { harness, conversationId } from './rpc/methods/up-next-harness'

// The shared RPC harness keeps drafts and queues in memory; disk scheduling is external.
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const observed = vi.hoisted(() => ({ ready: false, free: false, unverifiable: false }))
vi.mock('./conversation-readiness', () => ({ observeConversationReadiness: async () => observed }))
beforeEach(() => {
  Object.assign(observed, { ready: false, free: false, unverifiable: false })
})

it('requires a successful completed turn, not a fresh idle agent or unreachable host', async () => {
  const h = harness()
  const ready = async () => (await h.call('upNext.list', { conversationId })).view.finishReady
  expect(await ready()).toBe(false)
  observed.free = true
  expect(await ready()).toBe(false)
  observed.ready = true
  expect(await ready()).toBe(true)
  // A successful turn with no recorded commitment is never automatic archive evidence.
  expect((await h.call('upNext.list', { conversationId })).view.archiveProof).toBeUndefined()
  observed.unverifiable = true
  expect(await ready()).toBe(false)
  expect((await h.call('upNext.list', { conversationId })).view.archiveHasWork).toBe(false)
})

it('waits for composed and queued prompts rather than closing between turns', async () => {
  const h = harness()
  observed.ready = observed.free = true
  await h.call('upNext.append', {
    conversationId,
    draft: { kind: 'prompt', text: 'Continue', when: 'after' }
  })
  expect((await h.call('upNext.list', { conversationId })).view.finishReady).toBe(false)
  expect((await h.call('upNext.list', { conversationId })).view.archiveHasWork).toBe(true)
  await h.call('upNext.commit', { conversationId })
  expect((await h.call('upNext.list', { conversationId })).view.finishReady).toBe(false)
})

it('leaves the session open for an unresolved outcome even after its source stops working', async () => {
  const h = harness()
  observed.ready = observed.free = true
  await h.call('upNext.append', {
    conversationId,
    draft: { kind: 'agent', template: 'improve', instruction: 'Improve the result' }
  })
  await h.call('upNext.commit', { conversationId })
  expect(h.chains()).toHaveLength(1)
  expect((await h.call('upNext.list', { conversationId })).view.finishReady).toBe(false)
})
