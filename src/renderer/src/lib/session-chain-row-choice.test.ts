import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { isQueuedSessionChain, preferredSessionChain } from './session-chain-row-choice'

const now = 1_000_000_000

function plan(id: string, createdAt: number, patch: (chain: SessionChain) => void = () => {}) {
  const chain = conversationPlanFixture()
  chain.id = id
  chain.createdAt = createdAt
  patch(chain)
  return chain
}

const seal = (chain: SessionChain): void => {
  chain.outcomeSet!.completion = {
    at: 50,
    outcomes: [{ id: 'outcome', revision: 1 }],
    evidenceIds: []
  }
}

const stall = (chain: SessionChain): void => {
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
}

describe('isQueuedSessionChain', () => {
  it('queues nothing after a sealed, failed or cancelled run', () => {
    expect(isQueuedSessionChain(plan('live', 1), now)).toBe(true)
    expect(isQueuedSessionChain(plan('sealed', 1, seal), now)).toBe(false)
    expect(isQueuedSessionChain(plan('failed', 1, stall), now)).toBe(false)
    expect(
      isQueuedSessionChain(
        plan('cancelled', 1, (chain) => {
          chain.state = 'cancelled'
        }),
        now
      )
    ).toBe(false)
    expect(
      isQueuedSessionChain(
        plan('done', 1, (chain) => {
          chain.state = 'done'
        }),
        now
      )
    ).toBe(false)
  })

  it('keeps the old rule for a queue without outcomes: live, or failed until dismissed', () => {
    const { outcomeSet: _none, ...queue } = plan('queue', 1)
    expect(isQueuedSessionChain(queue, now)).toBe(true)
    expect(isQueuedSessionChain({ ...queue, state: 'failed' }, now)).toBe(true)
    expect(isQueuedSessionChain({ ...queue, state: 'done' }, now)).toBe(false)
    expect(isQueuedSessionChain({ ...queue, state: 'cancelled' }, now)).toBe(false)
  })
})

describe('preferredSessionChain', () => {
  it('picks the unfinished run over a newer finished one, whatever the order given', () => {
    const open = plan('open', 1)
    const sealed = plan('sealed', 9, seal)
    expect(preferredSessionChain([open, sealed], now)?.id).toBe('open')
    expect(preferredSessionChain([sealed, open], now)?.id).toBe('open')
  })

  it('picks the newest when every run is over, or every run is open', () => {
    const older = plan('older', 1, seal)
    const newer = plan('newer', 9, stall)
    expect(preferredSessionChain([newer, older], now)?.id).toBe('newer')
    expect(preferredSessionChain([older, newer], now)?.id).toBe('newer')
    expect(preferredSessionChain([plan('a', 1), plan('b', 2)], now)?.id).toBe('b')
    expect(preferredSessionChain([plan('b', 2), plan('a', 1)], now)?.id).toBe('b')
    expect(preferredSessionChain([], now)).toBeNull()
  })
})
