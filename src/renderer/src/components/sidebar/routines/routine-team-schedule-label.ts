import { translate, getIntlLocale } from '@/i18n/i18n'
import { formatAutomationScheduleTime } from '../../../../../shared/automation-schedules'
import { routineScheduleLabel } from './routine-schedule-label'

/** The converter emits only intervals or a single clock time, optionally on named weekdays. */
export function routineTeamScheduleLabel(cron: string): string {
  const [minute, hour, , , days] = cron.split(' ')
  if (hour.startsWith('*/') && Number(hour.slice(2)) > 1) {
    return translate('routineToTeam.everyHours', 'Every {{hours}} hours, at minute {{minute}}', {
      hours: Number(hour.slice(2)),
      minute: minute.padStart(2, '0')
    })
  }
  if (days !== '*') {
    const dayNames = days
      .split(',')
      .map((day) =>
        new Intl.DateTimeFormat(getIntlLocale(), { weekday: 'short', timeZone: 'UTC' }).format(
          new Date(Date.UTC(2023, 0, 1 + Number(day)))
        )
      )
    return translate('routineToTeam.weeklyTime', '{{days}} at {{time}}', {
      days: dayNames.join(', '),
      time: formatAutomationScheduleTime(Number(hour), Number(minute))
    })
  }
  return routineScheduleLabel(cron)
}
