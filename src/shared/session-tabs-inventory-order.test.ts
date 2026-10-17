import { describe, expect, it } from 'vitest'
import {
  compareSessionTabsInventoryOrder,
  readSessionTabsInventoryOrder,
  RetiredSessionTabsGenerations,
  withoutSessionTabsInventoryOrder
} from './session-tabs-inventory-order'

const at = (revision: number, projectionRevision?: number, generation = 'g1') => ({
  generation,
  revision,
  ...(projectionRevision !== undefined ? { projectionRevision } : {})
})

describe('session-tabs inventory order', () => {
  it('orders by revision within a generation and by projection revision on a tie', () => {
    expect(compareSessionTabsInventoryOrder(at(5), at(4))).toEqual({
      apply: true,
      reason: 'newer-inventory-revision'
    })
    expect(compareSessionTabsInventoryOrder(at(4), at(5))).toEqual({
      apply: false,
      reason: 'older-inventory-revision'
    })
    expect(compareSessionTabsInventoryOrder(at(5, 2), at(5, 1))).toEqual({
      apply: true,
      reason: 'newer-client-projection'
    })
    expect(compareSessionTabsInventoryOrder(at(5, 1), at(5, 2))).toEqual({
      apply: false,
      reason: 'older-client-projection'
    })
    expect(compareSessionTabsInventoryOrder(at(5), at(5, 0))).toEqual({
      apply: false,
      reason: 'same-inventory-revision'
    })
    // A newer inventory revision wins even with a lower projection revision (navigation reset).
    expect(compareSessionTabsInventoryOrder(at(6, 0), at(5, 3)).apply).toBe(true)
  })

  it('never orders two generations: any unretired one is accepted, a retired one never', () => {
    // Why: a restarted owner whose clock stepped backwards mints a generation that is "older" by
    // any timestamp; it must still be accepted, and its revisions start over.
    const restarted = at(1, undefined, 'g2')
    expect(compareSessionTabsInventoryOrder(restarted, at(900))).toEqual({
      apply: true,
      reason: 'newer-generation'
    })
    expect(
      compareSessionTabsInventoryOrder(at(900), restarted, (generation) => generation === 'g1')
    ).toEqual({ apply: false, reason: 'retired-generation' })
  })

  it('reads only well-formed metadata; anything else is legacy', () => {
    expect(readSessionTabsInventoryOrder({ inventoryOrder: at(3, 1) })).toEqual(at(3, 1))
    for (const inventoryOrder of [
      undefined,
      null,
      'x',
      { ...at(3), revision: -1 },
      { ...at(3), revision: 1.5 },
      { ...at(3), generation: '' },
      { ...at(3), projectionRevision: 'a' },
      { generation: 'g' }
    ]) {
      expect(readSessionTabsInventoryOrder({ inventoryOrder })).toBeNull()
    }
  })

  it('strips the metadata for a client that did not negotiate it', () => {
    const frame = { worktree: 'w', snapshotVersion: 3, inventoryOrder: at(3) }
    expect(withoutSessionTabsInventoryOrder(frame)).toEqual({ worktree: 'w', snapshotVersion: 3 })
    const legacy = { worktree: 'w', snapshotVersion: 3 }
    expect(withoutSessionTabsInventoryOrder(legacy)).toBe(legacy)
  })

  it('bounds retired generations, forgetting the oldest first', () => {
    const retired = new RetiredSessionTabsGenerations(2)
    retired.retire('a')
    retired.retire('b')
    retired.retire('c')
    expect([retired.has('a'), retired.has('b'), retired.has('c')]).toEqual([false, true, true])
  })
})
