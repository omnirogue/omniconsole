import { describe, expect, it } from 'vitest'
import { routineScheduleLabel } from './routine-schedule-label'

describe('routineScheduleLabel', () => {
  it.each([15, 30])('labels uniform minute intervals (%i)', (minutes) => {
    expect(routineScheduleLabel(`*/${minutes} * * * *`)).toBe(`Every ${minutes} min`)
  })
  it('reuses the RRULE hourly label', () => {
    expect(routineScheduleLabel('FREQ=HOURLY;BYMINUTE=5')).toBe('Hourly at :05')
  })
  it('reuses the weekday label', () => {
    expect(routineScheduleLabel('0 9 * * 1-5')).toContain('Weekdays')
  })
  it.each(['*/45 * * * *', '*/30 9 * * *', 'invalid'])('preserves custom text %s', (cron) => {
    expect(routineScheduleLabel(cron)).toBe(cron)
  })
})
