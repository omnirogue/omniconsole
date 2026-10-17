import { describe, expect, it } from 'vitest'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import {
  HOST_DELIVERY_QUEUED_MS,
  HOST_DELIVERY_SENDING_MS,
  settleQueuedEntry,
  type OwnerDeliveryDeps
} from './session-host-owner-delivery'
import { HOST_SOURCE } from './session-host-owner-test-host'

function queueOf(entry: PromptQueueEntry | null) {
  const clock = { now: 0 }
  let current = entry
  const withdrawn: string[] = []
  const deps: OwnerDeliveryDeps = {
    delivery: {} as OwnerDeliveryDeps['delivery'],
    readEntry: () => current,
    withdrawIfQueued: (_source, entryId, reason) => {
      if (current?.state !== 'queued') {
        return false
      }
      withdrawn.push(entryId)
      current = { ...current, state: 'failed', reason, unsent: true }
      return true
    },
    askWait: () => {
      throw new Error('not used')
    },
    sleep: async (ms) => {
      clock.now += ms
    },
    now: () => clock.now
  }
  return {
    deps,
    withdrawn,
    set: (next: PromptQueueEntry | null) => {
      current = next
    }
  }
}

const entry = (state: PromptQueueEntry['state'], extra: Partial<PromptQueueEntry> = {}) => ({
  id: 'e1',
  text: 'Summarize.',
  createdAt: 0,
  state,
  ...extra
})

describe('what the owner service reports for a queued prompt', () => {
  it('delivered is completed', async () => {
    const { deps } = queueOf(entry('delivered', { deliveredAt: 7, door: 'pty' }))
    expect(await settleQueuedEntry(deps, HOST_SOURCE, 'e1')).toEqual({
      kind: 'completed',
      result: { entryId: 'e1', deliveredAt: 7, door: 'pty' }
    })
  })

  it('still queued past its window is withdrawn unsent, so it is provably not delivered', async () => {
    const { deps, withdrawn } = queueOf(entry('queued'))
    const settled = await settleQueuedEntry(deps, HOST_SOURCE, 'e1')
    expect(withdrawn).toEqual(['e1'])
    expect(settled).toMatchObject({ kind: 'not-delivered', refusal: { code: 'not-eligible' } })
    expect(HOST_DELIVERY_QUEUED_MS).toBeGreaterThan(0)
  })

  it('a send that started and never reported is unconfirmed, never not-delivered', async () => {
    const { deps } = queueOf(entry('sending', { operationId: 'op' }))
    expect(await settleQueuedEntry(deps, HOST_SOURCE, 'e1')).toMatchObject({ kind: 'unconfirmed' })
    expect(HOST_DELIVERY_SENDING_MS).toBeGreaterThan(0)
  })

  it('a failure part-way is unconfirmed; one that sent nothing is not delivered', async () => {
    const partway = queueOf(entry('failed', { operationId: 'op', reason: 'write failed' }))
    expect(await settleQueuedEntry(partway.deps, HOST_SOURCE, 'e1')).toMatchObject({
      kind: 'unconfirmed'
    })
    const unsent = queueOf(entry('failed', { operationId: 'op', unsent: true, reason: 'changed' }))
    expect(await settleQueuedEntry(unsent.deps, HOST_SOURCE, 'e1')).toMatchObject({
      kind: 'not-delivered'
    })
  })

  it('removed by the person before it went out is the person’s input', async () => {
    const { deps } = queueOf(null)
    expect(await settleQueuedEntry(deps, HOST_SOURCE, 'e1')).toMatchObject({
      kind: 'not-delivered',
      refusal: { code: 'person-input' }
    })
  })
})
