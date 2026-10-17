import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''))
}))

import { formatAutomationScheduleTime } from '../../../../../shared/automation-schedules'
import { describeRoutineDays, describeRoutineWindowSchedule } from './routine-window-label'

describe('describeRoutineWindowSchedule', () => {
  it('reads an office-hours interval as one sentence', () => {
    expect(describeRoutineWindowSchedule('*/30 9-17 * * 1-5')).toBe(
      'Every 30 min · Mon–Fri · 09:00–17:59'
    )
  })

  it('drops the parts that do not restrict anything', () => {
    expect(describeRoutineWindowSchedule('*/15 * * * 0,6')).toBe('Every 15 min · Sun, Sat')
    expect(describeRoutineWindowSchedule('0 8-18 * * *')).toBe('Hourly · 08:00–18:59')
  })

  it('names a clock time with an unusual day set', () => {
    expect(describeRoutineWindowSchedule('30 9 * * 1,3,5')).toBe(
      `At ${formatAutomationScheduleTime(9, 30)} · Mon, Wed, Fri`
    )
  })

  it.each(['*/30 * * * *', '0 * * * *', '0 9 * * *', '0 9 * * 1-5', '0 9 * * 3', '5 * * * *', 'bad'])(
    'leaves %s to the plain schedule label',
    (cron) => {
      expect(describeRoutineWindowSchedule(cron)).toBeNull()
    }
  )
})

describe('describeRoutineDays', () => {
  it('collapses one run to a range and lists the rest', () => {
    expect(describeRoutineDays([1, 2, 3, 4, 5])).toBe('Mon–Fri')
    expect(describeRoutineDays([1, 2, 3, 6])).toBe('Mon, Tue, Wed, Sat')
    expect(describeRoutineDays([4])).toBe('Thu')
    expect(describeRoutineDays([0, 1, 2, 3, 4, 5, 6])).toBeNull()
  })
})
