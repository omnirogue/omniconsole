/**
 * A Person block's due date, as the person picks it and as the hub receives it: one ISO
 * timestamp with the local offset and no fractional seconds. A date alone is the end of that
 * local day. Every assertion is read in LOCAL time, so it holds in any CI timezone.
 */
import { describe, expect, it } from 'vitest'
import { UP_NEXT_REFUSAL_KEYS } from './up-next-types'
import { upNextChangeRefusal } from './up-next-order'
import {
  upNextDueAt,
  upNextDueChoice,
  upNextDueHasTime,
  upNextDueLabel,
  upNextDueParts,
  upNextDueRefusal
} from './up-next-person-due'

/** Offset and whole seconds only: the shape the relay's due_at pattern accepts. */
const WIRE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

describe('upNextDueAt', () => {
  it('reads a date alone as the end of that local day, with the local offset', () => {
    const dueAt = upNextDueAt('2026-09-20')!
    expect(dueAt).toMatch(WIRE)
    expect(dueAt.slice(0, 19)).toBe('2026-09-20T23:59:59')
    expect(Date.parse(dueAt)).toBe(new Date(2026, 8, 20, 23, 59, 59).getTime())
  })

  it('keeps the minute a time names, still with no fractional seconds', () => {
    const dueAt = upNextDueAt('2026-09-20', '15:30')!
    expect(dueAt).toMatch(WIRE)
    expect(dueAt.slice(0, 19)).toBe('2026-09-20T15:30:00')
    expect(Date.parse(dueAt)).toBe(new Date(2026, 8, 20, 15, 30).getTime())
  })

  it('refuses what is not a real date or clock time', () => {
    expect(upNextDueAt('')).toBeNull()
    expect(upNextDueAt('2026-02-30')).toBeNull()
    expect(upNextDueAt('20-09-2026')).toBeNull()
    expect(upNextDueAt('2026-09-20', '24:00')).toBeNull()
    expect(upNextDueAt('2026-09-20', '9:5')).toBeNull()
  })
})

describe('upNextDueParts', () => {
  it('round-trips a date-only due back to an empty time', () => {
    expect(upNextDueParts(upNextDueAt('2026-09-20')!)).toEqual({ date: '2026-09-20', time: '' })
    expect(upNextDueHasTime(upNextDueAt('2026-09-20')!)).toBe(false)
  })

  it('round-trips a timed due back to its date and time', () => {
    const dueAt = upNextDueAt('2026-09-20', '08:05')!
    expect(upNextDueParts(dueAt)).toEqual({ date: '2026-09-20', time: '08:05' })
    expect(upNextDueHasTime(dueAt)).toBe(true)
  })

  it('reads nothing from an absent or unreadable due', () => {
    expect(upNextDueParts(undefined)).toEqual({ date: '', time: '' })
    expect(upNextDueParts('not a date')).toEqual({ date: '', time: '' })
  })
})

describe('upNextDueLabel', () => {
  it('names the day, and the time only when one was chosen', () => {
    const day = new Date(2026, 8, 20).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
    const dayAndTime = new Date(2026, 8, 20, 15, 30).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
    expect(upNextDueLabel(upNextDueAt('2026-09-20')!)).toBe(day)
    expect(upNextDueLabel(upNextDueAt('2026-09-20', '15:30')!)).toBe(dayAndTime)
    expect(dayAndTime).not.toBe(day)
  })
})

describe('a due date in the past', () => {
  const now = new Date(2026, 8, 18, 12).getTime()

  it('is refused when the person sets it', () => {
    expect(upNextDueRefusal(upNextDueAt('2026-09-17')!, undefined, now)).toBe(
      UP_NEXT_REFUSAL_KEYS.dueInPast
    )
    expect(upNextDueRefusal(upNextDueAt('2026-09-18', '11:59')!, undefined, now)).toBe(
      UP_NEXT_REFUSAL_KEYS.dueInPast
    )
  })

  it('accepts later today, a future day, and clearing it', () => {
    expect(upNextDueRefusal(upNextDueAt('2026-09-18')!, undefined, now)).toBeUndefined()
    expect(upNextDueRefusal(upNextDueAt('2026-09-18', '12:01')!, undefined, now)).toBeUndefined()
    expect(upNextDueRefusal(undefined, upNextDueAt('2026-09-17')!, now)).toBeUndefined()
  })

  it('never refuses an unchanged due that passed while the block waited', () => {
    const passed = upNextDueAt('2026-09-17')!
    expect(upNextDueRefusal(passed, passed, now)).toBeUndefined()
  })

  it('is what the field makes of its inputs: set, clear, unchanged or past', () => {
    const stored = upNextDueAt('2026-09-20')!
    expect(upNextDueChoice('2026-09-21', '', stored, now)).toEqual({
      kind: 'set',
      dueAt: upNextDueAt('2026-09-21')
    })
    expect(upNextDueChoice('', '', stored, now)).toEqual({ kind: 'clear' })
    expect(upNextDueChoice('', '', undefined, now)).toEqual({ kind: 'unchanged' })
    expect(upNextDueChoice('2026-09-20', '', stored, now)).toEqual({ kind: 'unchanged' })
    expect(upNextDueChoice('2026-09-17', '', stored, now)).toEqual({ kind: 'past' })
  })

  it('is the host rule on an edit, beside the end-of-track rule', () => {
    const blocks = [
      { id: 'draft:a', kind: 'agent' as const },
      {
        id: 'draft:p',
        kind: 'person' as const,
        relationship: 'review' as const,
        receive: { dueAt: upNextDueAt('2026-09-17')! }
      }
    ]
    const change = (dueAt: string | undefined) =>
      upNextChangeRefusal(blocks, 'draft:p', { kind: 'person', receive: { dueAt } }, now)
    expect(change(upNextDueAt('2026-09-16')!)).toBe(UP_NEXT_REFUSAL_KEYS.dueInPast)
    expect(change(upNextDueAt('2026-09-19')!)).toBeUndefined()
    // Editing the note of a block whose due already passed carries the same due: not a change.
    expect(change(upNextDueAt('2026-09-17')!)).toBeUndefined()
    expect(
      upNextChangeRefusal(blocks, 'draft:a', { kind: 'person', relationship: 'handoff' }, now)
    ).toBe(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  })
})
