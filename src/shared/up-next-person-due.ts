/**
 * When a Person block's handoff or review is due.
 *
 * Optional, and authored in the person's own local time: a date alone means "by the end of
 * that day", a date and a time means that minute. What is stored and sent is one ISO timestamp
 * WITH the local offset and without fractional seconds — the shape the hub's `due_at` accepts
 * (`console-handoff-contract.ts`) — so the hub, the Work list and the Calendar all read the
 * same instant the person chose.
 */

import { UP_NEXT_REFUSAL_KEYS } from './up-next-types'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `2026-09-20T23:59:59-04:00`: local wall time and its offset, never milliseconds. */
function localTimestamp(at: Date): string {
  const offset = -at.getTimezoneOffset()
  const abs = Math.abs(offset)
  return (
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function isEndOfDay(at: Date): boolean {
  return at.getHours() === 23 && at.getMinutes() === 59 && at.getSeconds() === 59
}

/**
 * The due instant for a local date (`YYYY-MM-DD`) and an optional local time (`HH:MM`).
 * Null for anything that is not a real calendar date or clock time.
 */
export function upNextDueAt(date: string, time = ''): string | null {
  const day = DATE.exec(date)
  const clock = time ? CLOCK.exec(time) : null
  if (!day || (time && !clock)) {
    return null
  }
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])]
  const at = clock
    ? new Date(year, month - 1, dayOfMonth, Number(clock[1]), Number(clock[2]), 0)
    : new Date(year, month - 1, dayOfMonth, 23, 59, 59)
  // Why: `new Date` rolls 2026-02-30 into March; a date that moved is not the one chosen.
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== dayOfMonth) {
    return null
  }
  return localTimestamp(at)
}

/** The date and time inputs for a stored due; the time is empty for an end-of-day due. */
export function upNextDueParts(dueAt: string | undefined): { date: string; time: string } {
  const at = dueAt ? new Date(dueAt) : null
  if (!at || !Number.isFinite(at.getTime())) {
    return { date: '', time: '' }
  }
  return {
    date: `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: isEndOfDay(at) ? '' : `${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
}

/** True when the person chose a time as well as a date. */
export function upNextDueHasTime(dueAt: string): boolean {
  return upNextDueParts(dueAt).time !== ''
}

/** "Sep 20", or "Sep 20, 3:00 PM" when a time was chosen, in the reader's locale. */
export function upNextDueLabel(dueAt: string): string {
  const at = new Date(dueAt)
  if (!Number.isFinite(at.getTime())) {
    return dueAt
  }
  return upNextDueHasTime(dueAt)
    ? at.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** What the date and time inputs mean against the due already stored. */
export type UpNextDueChoice =
  | { kind: 'unchanged' }
  | { kind: 'clear' }
  | { kind: 'set'; dueAt: string }
  | { kind: 'past' }

/**
 * The due field's whole value rule, pure so any composer can mount it: no date clears it, a
 * date alone is the end of that local day, and a moment already past is refused.
 */
export function upNextDueChoice(
  date: string,
  time: string,
  stored: string | undefined,
  now: number
): UpNextDueChoice {
  if (!date) {
    return stored ? { kind: 'clear' } : { kind: 'unchanged' }
  }
  const dueAt = upNextDueAt(date, time)
  if (!dueAt || dueAt === stored) {
    return { kind: 'unchanged' }
  }
  return upNextDueRefusal(dueAt, stored, now) ? { kind: 'past' } : { kind: 'set', dueAt }
}

/**
 * Why a new due is refused: it has already passed. Only a CHANGE is judged — a block whose
 * due passed while it waited keeps it, so editing its note is never refused for that.
 */
export function upNextDueRefusal(
  next: string | undefined,
  current: string | undefined,
  now: number
): string | undefined {
  if (!next || next === current) {
    return undefined
  }
  const at = Date.parse(next)
  return Number.isFinite(at) && at <= now ? UP_NEXT_REFUSAL_KEYS.dueInPast : undefined
}
