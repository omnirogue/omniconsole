import { translate } from '@/i18n/i18n'
import { describeAutomationSchedule } from '../../../../../shared/automation-schedules'
import { isValidAutomationCronSchedule } from '../../../../../shared/automation-schedule-parsing'
import { formatUiAutomationScheduleDescriptor } from '@/components/automations/automation-schedule-label'

export function routineScheduleLabel(expression: string): string {
  const schedule = expression.trim()
  const interval = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(schedule)
  if (interval && isValidAutomationCronSchedule(schedule)) {
    const minutes = Number(interval[1])
    // Why: non-divisors reset at the hour, so they are not uniform intervals.
    if (minutes > 0 && minutes < 60 && 60 % minutes === 0) {
      return translate('routines.everyMinutes', 'Every {{minutes}} min', { minutes })
    }
  }
  const descriptor = describeAutomationSchedule(schedule)
  return descriptor.kind === 'custom' || descriptor.kind === 'invalid'
    ? schedule
    : formatUiAutomationScheduleDescriptor(descriptor)
}
