import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import { holdPromptQueueAfterDelivery, isPromptQueueDeliveryHeld } from './prompt-queue-drain'
import { conversationId, harness, rowKey } from './rpc/methods/up-next-harness'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
const pane = vi.hoisted(() => ({ readiness: {} as Record<string, unknown> }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => pane.readiness
}))

const FINISHED = { ready: true, free: true, unverifiable: false, version: 'turn1' }

beforeEach(() => {
  pane.readiness = { ...FINISHED }
})

async function sleepClear(test: ReturnType<typeof harness>): Promise<boolean | undefined> {
  return (await test.call('upNext.list', { conversationId })).view.archiveSleepClear
}

it('keeps an archived agent awake until a just-delivered queued prompt starts its turn', async () => {
  const test = harness()
  const runtime = test.ctx.runtime as unknown as OrcaRuntimeService
  expect(await sleepClear(test)).toBe(true)
  // The drain typed the last queued prompt in: nothing is queued now, and the pane still reads
  // the turn that finished before the write.
  holdPromptQueueAfterDelivery(runtime, rowKey, 'turn1')
  expect(await sleepClear(test)).toBe(false)
  pane.readiness = { ready: false, free: false, unverifiable: false }
  expect(await sleepClear(test)).toBe(false)
  // It took the prompt up and finished a different turn.
  pane.readiness = { ...FINISHED, version: 'turn2' }
  expect(await sleepClear(test)).toBe(true)
})

it('reads the hold without marking or releasing it for the drain', () => {
  const runtime = {} as OrcaRuntimeService
  const start = 1_000_000
  expect(isPromptQueueDeliveryHeld(runtime, rowKey, FINISHED, start)).toBe(false)
  vi.useFakeTimers({ now: start })
  try {
    holdPromptQueueAfterDelivery(runtime, rowKey, 'turn1')
  } finally {
    vi.useRealTimers()
  }
  const busy = { free: false, unverifiable: false }
  expect(isPromptQueueDeliveryHeld(runtime, rowKey, busy, start + 1)).toBe(true)
  const later = { ...FINISHED, version: 'turn2' }
  expect(isPromptQueueDeliveryHeld(runtime, rowKey, later, start)).toBe(false)
  // Neither reading above changed the hold: the same finished turn is still held.
  expect(isPromptQueueDeliveryHeld(runtime, rowKey, FINISHED, start + 1)).toBe(true)
  expect(isPromptQueueDeliveryHeld(runtime, rowKey, FINISHED, start + 3 * 60_000)).toBe(false)
})
