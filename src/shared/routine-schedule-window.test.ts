import { describe, expect, it } from 'vitest'
import { isValidAutomationCronSchedule } from './automation-schedule-parsing'
import {
  buildRoutineWindowCron,
  formatRoutineCronDays,
  parseRoutineWindowCron,
  routineWindowPreset,
  routineWindowProblem,
  ROUTINE_ALL_DAYS,
  ROUTINE_ALL_HOURS,
  ROUTINE_MONDAY_TO_FRIDAY,
  type RoutineScheduleWindow
} from './routine-schedule-window'

const officeHours: RoutineScheduleWindow = {
  cadence: { kind: 'interval', minutes: 30 },
  days: ROUTINE_MONDAY_TO_FRIDAY,
  hours: { from: 9, to: 17 }
}

describe('buildRoutineWindowCron', () => {
  it('composes an interval with an hour window and a weekday range', () => {
    expect(buildRoutineWindowCron(officeHours)).toBe('*/30 9-17 * * 1-5')
  })

  it('omits the hour range when all day and the days when every day', () => {
    expect(
      buildRoutineWindowCron({
        cadence: { kind: 'interval', minutes: 15 },
        days: ROUTINE_ALL_DAYS,
        hours: ROUTINE_ALL_HOURS
      })
    ).toBe('*/15 * * * *')
  })

  it('writes every hour as minute zero and a single-hour window as one hour', () => {
    expect(
      buildRoutineWindowCron({
        cadence: { kind: 'interval', minutes: 60 },
        days: [0, 6],
        hours: { from: 8, to: 8 }
      })
    ).toBe('0 8 * * 0,6')
  })

  it('builds clock-time cadences through the shared preset builder and applies the day chips', () => {
    const daily: RoutineScheduleWindow = {
      cadence: { kind: 'time', hour: 9, minute: 5 },
      days: ROUTINE_ALL_DAYS,
      hours: ROUTINE_ALL_HOURS
    }
    expect(buildRoutineWindowCron(daily)).toBe('5 9 * * *')
    expect(buildRoutineWindowCron({ ...daily, days: [1, 3, 5] })).toBe('5 9 * * 1,3,5')
    expect(buildRoutineWindowCron({ ...daily, days: [1, 2, 3, 6] })).toBe('5 9 * * 1-3,6')
    expect(buildRoutineWindowCron({ ...daily, days: [4] })).toBe('5 9 * * 4')
  })

  it('always yields a cron the scheduler accepts', () => {
    for (const window of [
      officeHours,
      { ...officeHours, cadence: { kind: 'interval', minutes: 5 } as const },
      { ...officeHours, cadence: { kind: 'time', hour: 23, minute: 59 } as const }
    ]) {
      expect(isValidAutomationCronSchedule(buildRoutineWindowCron(window))).toBe(true)
    }
  })
})

describe('parseRoutineWindowCron', () => {
  it('reads the office-hours interval back into the controls', () => {
    expect(parseRoutineWindowCron('*/30 9-17 * * 1-5')).toEqual(officeHours)
  })

  it('accepts listed minutes and day names as the same window', () => {
    expect(parseRoutineWindowCron('0,30 9-17 * * MON-FRI')).toEqual(officeHours)
  })

  it('reads every-hour windows and plain intervals', () => {
    expect(parseRoutineWindowCron('0 8-18 * * *')).toEqual({
      cadence: { kind: 'interval', minutes: 60 },
      days: ROUTINE_ALL_DAYS,
      hours: { from: 8, to: 18 }
    })
    expect(parseRoutineWindowCron('*/10 * * * *')).toEqual({
      cadence: { kind: 'interval', minutes: 10 },
      days: ROUTINE_ALL_DAYS,
      hours: ROUTINE_ALL_HOURS
    })
  })

  it('reads clock-time cadences with their days', () => {
    expect(parseRoutineWindowCron('0 9 * * 1-5')).toEqual({
      cadence: { kind: 'time', hour: 9, minute: 0 },
      days: ROUTINE_MONDAY_TO_FRIDAY,
      hours: ROUTINE_ALL_HOURS
    })
    expect(parseRoutineWindowCron('30 18 * * 7')?.days).toEqual([0])
  })

  it.each([
    '5 * * * *',
    '*/45 * * * *',
    '*/30 9,13 * * *',
    '0 9 1 * *',
    '0 9 * 6 *',
    'invalid',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
  ])('leaves %s to the custom editor', (cron) => {
    expect(parseRoutineWindowCron(cron)).toBeNull()
  })

  it('round-trips what it composes', () => {
    for (const cron of ['*/5 6-9 * * 0,6', '15 7 * * 2,4', '0 * * * *', '*/15 * * * 1-3,5']) {
      expect(buildRoutineWindowCron(parseRoutineWindowCron(cron)!)).toBe(cron)
    }
  })
})

describe('routine window presets and problems', () => {
  it('names a clock time by its days', () => {
    const at9 = { cadence: { kind: 'time', hour: 9, minute: 0 } as const, hours: ROUTINE_ALL_HOURS }
    expect(routineWindowPreset({ ...at9, days: ROUTINE_ALL_DAYS })).toBe('daily')
    expect(routineWindowPreset({ ...at9, days: ROUTINE_MONDAY_TO_FRIDAY })).toBe('weekdays')
    expect(routineWindowPreset({ ...at9, days: [3] })).toBe('weekly')
    expect(routineWindowPreset({ ...at9, days: [1, 3] })).toBe('daily')
    expect(routineWindowPreset(officeHours)).toBe('interval')
  })

  it('refuses no days and an inverted hour window', () => {
    expect(routineWindowProblem(officeHours)).toBeNull()
    expect(routineWindowProblem({ ...officeHours, days: [] })).toBe('no-days')
    expect(routineWindowProblem({ ...officeHours, hours: { from: 18, to: 9 } })).toBe('hours-order')
    expect(
      routineWindowProblem({
        ...officeHours,
        cadence: { kind: 'time', hour: 9, minute: 0 },
        hours: { from: 18, to: 9 }
      })
    ).toBeNull()
  })

  it('formats day fields without duplicates or out-of-range values', () => {
    expect(formatRoutineCronDays([5, 1, 1, 9, -1])).toBe('1,5')
    expect(formatRoutineCronDays([6, 5, 4, 3, 2, 1, 0])).toBe('*')
  })
})
