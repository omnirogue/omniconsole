import { describe, expect, it } from 'vitest'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { recordSessionOutcomeWaitFact } from './session-outcome-wait-facts'

const set = {
  outcomes: [{ id: 'o', conditions: [{ id: 'c', kind: 'event', target: 't' }], waits: [] }]
} as unknown as SessionOutcomeSet

describe('recordSessionOutcomeWaitFact', () => {
  it('rewrites an unchanged reading at most every 30 s, and a changed one at once', () => {
    const first = recordSessionOutcomeWaitFact(set, 'o', 'c', {
      status: 'pending',
      checkedAt: 1_000
    })
    expect(
      recordSessionOutcomeWaitFact(first, 'o', 'c', { status: 'pending', checkedAt: 3_000 })
    ).toBe(first)
    const later = recordSessionOutcomeWaitFact(first, 'o', 'c', {
      status: 'pending',
      checkedAt: 31_000
    })
    expect(later.outcomes[0]!.waits![0]!.checkedAt).toBe(31_000)
    const met = recordSessionOutcomeWaitFact(first, 'o', 'c', { status: 'met', checkedAt: 2_000 })
    expect(met.outcomes[0]!.waits![0]).toMatchObject({ status: 'met', checkedAt: 2_000 })
  })
})
