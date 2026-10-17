import { describe, expect, it } from 'vitest'
import { convertRruleToUtcCron as convert } from './routine-schedule-to-cron'

const base = {
  dtstart: Date.parse('2026-01-01T09:15:00Z'),
  timezone: 'UTC',
  currentYear: 2026
}
describe('UTC cron conversion', () => {
  it.each([
    ['FREQ=MINUTELY;INTERVAL=15', '*/15 * * * *'],
    ['RRULE:FREQ=MINUTELY;INTERVAL=1', '*/1 * * * *'],
    ['FREQ=HOURLY;INTERVAL=3', '15 */3 * * *'],
    ['FREQ=HOURLY;BYMINUTE=30', '30 */1 * * *'],
    ['FREQ=DAILY', '15 9 * * *'],
    ['FREQ=DAILY;BYHOUR=9,9;BYMINUTE=15,15', '15 9 * * *'],
    ['RRULE:FREQ=DAILY;BYHOUR=14;BYMINUTE=0', '0 14 * * *'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', '15 9 * * 0,1,2,3,4,5,6'],
    ['FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=0;BYMINUTE=0', '0 0 * * 1,5']
  ])('converts %s', (rrule, cron) =>
    expect(convert({ ...base, rrule })).toMatchObject({ ok: true, cron })
  )

  it.each([
    ['', 'missing'],
    ['FREQ=DAILY;COUNT=3', 'count'],
    ['FREQ=DAILY;UNTIL=20261231T000000Z', 'until'],
    ['FREQ=WEEKLY;BYSETPOS=1', 'position'],
    ['FREQ=MONTHLY', 'monthly'],
    ['FREQ=DAILY;BYMONTHDAY=1', 'monthly'],
    ['FREQ=YEARLY', 'yearly'],
    ['FREQ=DAILY;BYHOUR=9,14', 'multiple'],
    ['FREQ=DAILY;BYMINUTE=1,40', 'multiple'],
    ['FREQ=MINUTELY;INTERVAL=7', 'minuteInterval'],
    ['FREQ=HOURLY;INTERVAL=5', 'hourInterval'],
    ['garbage', 'unknown'],
    ['FREQ=SECONDLY', 'unknown'],
    ['FREQ=DAILY;BYMONTH=1', 'unknown'],
    ['FREQ=DAILY;INTERVAL=2', 'unknown'],
    ['FREQ=WEEKLY', 'unknown'],
    ['FREQ=WEEKLY;BYDAY=1MO', 'unknown'],
    ['FREQ=DAILY;BYHOUR=24', 'unknown'],
    ['FREQ=DAILY;BYMINUTE=60', 'unknown'],
    ['FREQ=DAILY;INTERVAL=0', 'unknown'],
    ['FREQ=DAILY;INTERVAL=1.5', 'unknown'],
    ['FREQ=DAILY;FREQ=HOURLY', 'unknown'],
    ['FREQ=HOURLY;BYDAY=MO', 'unknown'],
    ['FREQ=MINUTELY;BYHOUR=1', 'unknown'],
    ['FREQ=DAILY;BYHOUR=', 'unknown'],
    ['FREQ=DAILY;BYSECOND=30', 'unknown']
  ])('refuses %s with %s', (rrule, code) => {
    expect(convert({ ...base, rrule })).toMatchObject({
      ok: false,
      code,
      reason: expect.any(String)
    })
  })
  it.each(['FREQ=DAILY;BYHOUR=2;BYMINUTE=30', 'FREQ=WEEKLY;BYDAY=SU'])(
    'refuses DST crossings: %s',
    (rrule) => {
      expect(convert({ ...base, timezone: 'America/New_York', rrule })).toMatchObject({
        ok: false,
        code: 'dst'
      })
    }
  )
  it('allows hourly cadence even in a DST zone', () => {
    expect(
      convert({
        ...base,
        timezone: 'America/New_York',
        rrule: 'FREQ=HOURLY;INTERVAL=2'
      })
    ).toMatchObject({ ok: true, cron: '15 */2 * * *' })
  })
  it('converts fixed-offset IANA clocks', () => {
    expect(
      convert({
        ...base,
        timezone: 'Etc/GMT+5',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
      })
    ).toMatchObject({ ok: true, cron: '0 14 * * *' })
  })
  it('converts fractional offsets and rolls weekly days backward', () => {
    expect(
      convert({
        ...base,
        timezone: 'Asia/Kolkata',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,SU;BYHOUR=0;BYMINUTE=15'
      })
    ).toMatchObject({ ok: true, cron: '45 18 * * 0,6' })
  })
  it('rolls weekly days forward', () => {
    expect(
      convert({
        ...base,
        timezone: 'Etc/GMT+5',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=23;BYMINUTE=0'
      })
    ).toMatchObject({ ok: true, cron: '0 4 * * 0' })
  })
  it('preserves an explicit ISO offset without a zone', () => {
    expect(convert({ dtstart: '2026-01-01T09:15:00+05:30', rrule: 'FREQ=DAILY' })).toMatchObject({
      ok: true,
      cron: '45 3 * * *'
    })
  })
  it.each([
    { dtstart: Number.NaN },
    { timezone: 'not-a-zone' },
    { dtstart: '2026-01-01T09:00:00' }
  ])('refuses ambiguous or invalid clocks %j', (patch) => {
    expect(convert({ ...base, ...patch, rrule: 'FREQ=DAILY' })).toMatchObject({
      ok: false,
      code: 'unknown'
    })
  })
})
