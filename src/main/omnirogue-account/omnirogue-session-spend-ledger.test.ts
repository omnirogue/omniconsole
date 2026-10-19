import { describe, expect, it, vi } from 'vitest'
import {
  getSharedOmniRogueSessionSpendLedger,
  OmniRogueSessionSpendLedger
} from './omnirogue-session-spend-ledger'

function createLedger(maxSessions?: number): OmniRogueSessionSpendLedger {
  let clock = 1_000
  return new OmniRogueSessionSpendLedger({ now: () => (clock += 1), maxSessions })
}

describe('OmniRogueSessionSpendLedger', () => {
  it('settles a reserved request into spend and attributes it to the reserved model', () => {
    const ledger = createLedger()

    const reserved = ledger.reserve(' session-a ', ' req-1 ', 5, 'claude-opus')
    expect(reserved).toMatchObject({ ok: true, snapshot: { reservedCredits: 5, spentCredits: 0 } })

    const settled = ledger.settle('session-a', 'req-1', 3.5)
    expect(settled).toMatchObject({
      ok: true,
      snapshot: {
        sessionId: 'session-a',
        spentCredits: 3.5,
        reservedCredits: 0,
        requestCount: 1,
        creditsByModel: { 'claude-opus': 3.5 },
        updatedAt: 1_002
      }
    })
  })

  it('records direct charges without a reservation under the given or unknown model', () => {
    const ledger = createLedger()

    ledger.settle('s', 'r1', 2, 'gpt-6')
    ledger.settle('s', 'r2', 1)
    ledger.settle('s', 'r3', 0.5, '  ')

    expect(ledger.snapshot('s')).toMatchObject({
      spentCredits: 3.5,
      requestCount: 3,
      creditsByModel: { 'gpt-6': 2, unknown: 1.5 }
    })
  })

  it('keeps fractional credit totals free of float drift', () => {
    const ledger = createLedger()

    ledger.settle('s', 'r1', 0.1, 'm')
    ledger.settle('s', 'r2', 0.2, 'm')

    expect(ledger.snapshot('s')).toMatchObject({ spentCredits: 0.3, creditsByModel: { m: 0.3 } })
  })

  it('treats sessions without a budget as unlimited', () => {
    const ledger = createLedger()
    const unlimited = { allowed: true, level: 'ok', remainingCredits: null, shortfallCredits: 0 }

    expect(ledger.check('never-seen', 1_000_000)).toEqual(unlimited)

    ledger.setBudget('s', 1)
    ledger.settle('s', 'r1', 5)
    expect(ledger.check('s').allowed).toBe(false)

    ledger.setBudget('s', null)
    expect(ledger.check('s', 1_000)).toEqual(unlimited)
  })

  it('guards reservations against the budget with warning and shortfall details', () => {
    const ledger = createLedger()
    ledger.setBudget('s', 10)

    expect(ledger.reserve('s', 'r1', 7).ok).toBe(true)
    expect(ledger.check('s')).toMatchObject({ allowed: true, level: 'ok', remainingCredits: 3 })
    expect(ledger.check('s', 1)).toEqual({
      allowed: true,
      level: 'warning',
      remainingCredits: 3,
      shortfallCredits: 0
    })
    expect(ledger.check('s', 4)).toEqual({
      allowed: false,
      level: 'exceeded',
      remainingCredits: 3,
      shortfallCredits: 1
    })

    expect(ledger.reserve('s', 'r2', 4)).toMatchObject({
      ok: false,
      reason: 'over_budget',
      snapshot: { reservedCredits: 7 }
    })
    expect(ledger.reserve('s', 'r2', 3).ok).toBe(true)
    expect(ledger.snapshot('s').guard).toEqual({
      allowed: true,
      level: 'warning',
      remainingCredits: 0,
      shortfallCredits: 0
    })
  })

  it('flags a settlement that overruns its reservation and blocks further reservations', () => {
    const ledger = createLedger()
    ledger.setBudget('s', 5)
    ledger.reserve('s', 'r1', 4)

    const settled = ledger.settle('s', 'r1', 6)

    expect(settled.snapshot?.guard).toEqual({
      allowed: false,
      level: 'exceeded',
      remainingCredits: 0,
      shortfallCredits: 1
    })
    expect(ledger.reserve('s', 'r2', 0)).toMatchObject({ ok: false, reason: 'over_budget' })
  })

  it('rejects duplicate reservations and settlements without double counting', () => {
    const ledger = createLedger()

    ledger.reserve('s', 'r1', 2)
    expect(ledger.reserve('s', 'r1', 2)).toMatchObject({ ok: false, reason: 'duplicate_request' })

    ledger.settle('s', 'r1', 2)
    expect(ledger.settle('s', 'r1', 2)).toMatchObject({
      ok: false,
      reason: 'duplicate_request',
      snapshot: { spentCredits: 2 }
    })
    expect(ledger.reserve('s', 'r1', 1)).toMatchObject({ ok: false, reason: 'duplicate_request' })
    expect(ledger.snapshot('s')).toMatchObject({
      spentCredits: 2,
      reservedCredits: 0,
      requestCount: 1
    })
  })

  it('releases a pending reservation back to the budget', () => {
    const ledger = createLedger()
    ledger.setBudget('s', 5)
    ledger.reserve('s', 'r1', 5)
    expect(ledger.check('s', 1).allowed).toBe(false)

    expect(ledger.release('s', 'r1')).toMatchObject({ ok: true, snapshot: { reservedCredits: 0 } })
    expect(ledger.check('s', 1).allowed).toBe(true)
    expect(ledger.release('s', 'r1')).toMatchObject({ ok: false, reason: 'unknown_request' })
    expect(ledger.release('missing', 'r1')).toEqual({
      ok: false,
      reason: 'unknown_request',
      snapshot: null
    })
  })

  it('rejects invalid ids and credit amounts without creating sessions', () => {
    const ledger = createLedger()

    expect(ledger.reserve('  ', 'r1', 1)).toEqual({
      ok: false,
      reason: 'invalid_request',
      snapshot: null
    })
    expect(ledger.settle('s', '', 1)).toMatchObject({ ok: false, reason: 'invalid_request' })
    expect(ledger.setBudget('', 5)).toMatchObject({ ok: false, reason: 'invalid_request' })
    expect(ledger.reserve('s', 'r1', -1)).toMatchObject({ ok: false, reason: 'invalid_credits' })
    expect(ledger.settle('s', 'r1', Number.NaN)).toMatchObject({
      ok: false,
      reason: 'invalid_credits'
    })
    expect(ledger.setBudget('s', Number.POSITIVE_INFINITY)).toMatchObject({
      ok: false,
      reason: 'invalid_credits'
    })
    expect(ledger.check('s', Number.NaN).allowed).toBe(false)
    expect(ledger.list()).toEqual([])
  })

  it('evicts the least recently updated idle session but keeps sessions with reservations', () => {
    const ledger = createLedger(2)

    ledger.reserve('pending', 'r1', 1)
    ledger.settle('idle', 'r1', 1)
    ledger.settle('fresh', 'r1', 1)

    expect(ledger.list().map((snapshot) => snapshot.sessionId)).toEqual(['fresh', 'pending'])
    expect(ledger.snapshot('idle')).toMatchObject({ spentCredits: 0, updatedAt: null })
  })

  it('moves a session to most recently used whenever it changes', () => {
    const ledger = createLedger(2)

    ledger.settle('a', 'r1', 1)
    ledger.settle('b', 'r1', 1)
    ledger.settle('a', 'r2', 1)
    ledger.settle('c', 'r1', 1)

    expect(ledger.list().map((snapshot) => snapshot.sessionId)).toEqual(['a', 'c'])
  })

  it('notifies subscribers, isolates failing ones and stops after unsubscribe', () => {
    const ledger = createLedger()
    const seen: number[] = []
    ledger.onChange(() => {
      throw new Error('subscriber failure')
    })
    const unsubscribe = ledger.onChange((snapshot) => {
      seen.push(snapshot.spentCredits)
    })

    ledger.settle('s', 'r1', 2)
    unsubscribe()
    ledger.settle('s', 'r2', 3)

    expect(seen).toEqual([2])
    expect(ledger.snapshot('s').spentCredits).toBe(5)
  })

  it('lists sessions by spend and clears a session with an empty snapshot event', () => {
    const ledger = createLedger()
    ledger.settle('b', 'r1', 1)
    ledger.settle('a', 'r1', 4)
    ledger.settle('c', 'r1', 1)

    expect(ledger.list().map((snapshot) => snapshot.sessionId)).toEqual(['a', 'b', 'c'])

    const listener = vi.fn()
    ledger.onChange(listener)
    expect(ledger.clear('a')).toBe(true)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'a', spentCredits: 0, updatedAt: null })
    )
    expect(ledger.clear('a')).toBe(false)
    expect(ledger.list().map((snapshot) => snapshot.sessionId)).toEqual(['b', 'c'])
  })

  it('exposes one shared ledger for the main process', () => {
    expect(getSharedOmniRogueSessionSpendLedger()).toBe(getSharedOmniRogueSessionSpendLedger())
    expect(getSharedOmniRogueSessionSpendLedger()).toBeInstanceOf(OmniRogueSessionSpendLedger)
  })
})
