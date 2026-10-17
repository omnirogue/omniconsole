import { describe, expect, it } from 'vitest'
import {
  askAllowance,
  nudgeAllowance,
  promptsToday,
  STEWARD_ASK_EVERY_MS,
  STEWARD_NUDGE_EVERY_MS,
  yesAllowance
} from './steward-caps'

const DAY = '2026-09-25'

describe('Yes limits', () => {
  it('allows 3 a day, never twice on one turn, and resets the count on a new day', () => {
    let state = undefined as Parameters<typeof yesAllowance>[0]
    for (let turn = 1; turn <= 3; turn += 1) {
      const verdict = yesAllowance(state, { turnKey: `t${turn}`, evidence: `head-${turn}` }, DAY)
      expect(verdict.ok).toBe(true)
      state = verdict.ok ? verdict.next : state
    }
    expect(yesAllowance(state, { turnKey: 't4', evidence: 'head-4' }, DAY)).toEqual({
      ok: false,
      reason: 'The steward already said yes to it 3 times today'
    })
    expect(yesAllowance(state, { turnKey: 't3', evidence: 'head-9' }, '2026-09-26')).toEqual({
      ok: false,
      reason: 'The steward already answered this turn'
    })
    expect(yesAllowance(state, { turnKey: 't4', evidence: 'head-4' }, '2026-09-26').ok).toBe(true)
  })

  it('stops after 2 turns in a row that brought no new commits or changes', () => {
    const first = yesAllowance(undefined, { turnKey: 't1', evidence: 'same' }, DAY)
    expect(first).toMatchObject({ ok: true, next: { noEvidenceTurns: 0 } })
    const second = yesAllowance(
      first.ok ? first.next : undefined,
      { turnKey: 't2', evidence: 'same' },
      DAY
    )
    expect(second).toMatchObject({ ok: true, next: { noEvidenceTurns: 1 } })
    const third = yesAllowance(
      second.ok ? second.next : undefined,
      { turnKey: 't3', evidence: 'same' },
      DAY
    )
    expect(third).toEqual({
      ok: false,
      reason: '2 turns in a row since its last steward Yes brought no new commits or file changes'
    })
    // New evidence (a commit) re-arms it.
    const fresh = yesAllowance(
      second.ok ? second.next : undefined,
      { turnKey: 't3', evidence: 'new' },
      DAY
    )
    expect(fresh).toMatchObject({ ok: true, next: { noEvidenceTurns: 0 } })
  })

  it('reads unreadable git as no new evidence, and refuses a turn it cannot read', () => {
    const first = yesAllowance(undefined, { turnKey: 't1', evidence: null }, DAY)
    const second = yesAllowance(
      first.ok ? first.next : undefined,
      { turnKey: 't2', evidence: null },
      DAY
    )
    expect(second).toMatchObject({ ok: true, next: { noEvidenceTurns: 1 } })
    expect(yesAllowance(undefined, { turnKey: null, evidence: 'x' }, DAY).ok).toBe(false)
  })
})

describe('nudge and question limits', () => {
  it('nudges once per 12 h and twice in all', () => {
    const first = nudgeAllowance(undefined, 1_000, 't1')
    expect(first).toEqual({ ok: true, next: { count: 1, lastAt: 1_000, lastTurnKey: 't1' } })
    const early = nudgeAllowance(
      { count: 1, lastAt: 1_000 },
      1_000 + STEWARD_NUDGE_EVERY_MS - 1,
      't2'
    )
    expect(early).toMatchObject({ ok: false, at: 1_000 + STEWARD_NUDGE_EVERY_MS })
    expect(
      nudgeAllowance({ count: 1, lastAt: 1_000 }, 1_000 + STEWARD_NUDGE_EVERY_MS, 't2').ok
    ).toBe(true)
    expect(nudgeAllowance({ count: 2, lastAt: 0 }, 10 * STEWARD_NUDGE_EVERY_MS, 't3')).toEqual({
      ok: false,
      reason: 'The steward already nudged it 2 times'
    })
  })

  it('asks whether it is done once per 24 h', () => {
    expect(askAllowance(undefined, 5, 't1')).toEqual({ ok: true, next: { at: 5, turnKey: 't1' } })
    expect(askAllowance({ at: 5 }, 5 + STEWARD_ASK_EVERY_MS - 1, 't2').ok).toBe(false)
    expect(askAllowance({ at: 5 }, 5 + STEWARD_ASK_EVERY_MS, 't2').ok).toBe(true)
  })

  it('counts prompts per day without capping them, from zero on a new day', () => {
    expect(promptsToday({ day: DAY, prompts: 70 }, DAY)).toBe(70)
    expect(promptsToday({ day: DAY, prompts: 70 }, '2026-09-26')).toBe(0)
  })
})
