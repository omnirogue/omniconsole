import { describe, expect, it } from 'vitest'
import { calendarDays, dayKey, entryOnDay, shiftDay, shiftMonth } from './calendar-dates'

describe('local calendar days', () => {
  it('steps through DST days and clamps month navigation', () => {
    expect(shiftDay('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28')
    expect(shiftMonth('2028-01-31', 1)).toBe('2028-02-29')
    expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-31')
  })

  it('retains date-only deadlines and converts timed entries in local time', () => {
    expect(dayKey('2026-09-15')).toBe('2026-09-15')
    expect(dayKey(new Date(2026, 8, 15, 23, 30).toISOString())).toBe('2026-09-15')
  })

  it('uses a stable six-week month and exclusive end instants', () => {
    expect(calendarDays('2026-09-15', 'month')).toHaveLength(42)
    expect(calendarDays('2026-09-15', 'week')).toHaveLength(7)
    const meeting = {
      starts_at: new Date(2026, 8, 15, 23).toISOString(),
      ends_at: new Date(2026, 8, 17).toISOString()
    }
    expect(entryOnDay(meeting, '2026-09-15')).toBe(true)
    expect(entryOnDay(meeting, '2026-09-16')).toBe(true)
    expect(entryOnDay(meeting, '2026-09-17')).toBe(false)
  })
})
