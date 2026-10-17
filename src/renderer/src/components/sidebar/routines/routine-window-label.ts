import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatAutomationScheduleTime } from '../../../../../shared/automation-schedules'
import {
  contiguousRuns,
  isAllDayRoutineHours,
  isEveryRoutineDay,
  parseRoutineWindowCron,
  routineWindowPreset,
  type RoutineScheduleWindow
} from '../../../../../shared/routine-schedule-window'

// Why: short weekday names are language words too; resolve them the way weekday-names.ts does
// and cache per UI locale, since the language can change at runtime.
let cached: { locale: string; names: readonly string[] } | null = null
const SUNDAY_UTC_MS = Date.UTC(2026, 0, 4)
const DAY_MS = 24 * 60 * 60 * 1000

/** Abbreviated weekday names in the UI language, Sunday first, indexed by cron day-of-week. */
export function getUiShortWeekdayNames(): readonly string[] {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    cached = {
      locale,
      names: Array.from({ length: 7 }, (_, index) =>
        formatter.format(new Date(SUNDAY_UTC_MS + index * DAY_MS))
      )
    }
  }
  return cached.names
}

/** `Mon–Fri` for one contiguous run, otherwise `Mon, Wed, Fri`; null when every day is allowed. */
export function describeRoutineDays(days: readonly number[]): string | null {
  if (isEveryRoutineDay(days)) {
    return null
  }
  const names = getUiShortWeekdayNames()
  const runs = contiguousRuns(days)
  if (runs.length === 1 && runs[0]![0] !== runs[0]![1]) {
    return `${names[runs[0]![0]]}–${names[runs[0]![1]]}`
  }
  return days.map((day) => names[day]).join(', ')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `09:00–17:59` for an interval's allowed hours; null when it may run all day. */
export function describeRoutineHours(hours: RoutineScheduleWindow['hours']): string | null {
  return isAllDayRoutineHours(hours) ? null : `${pad(hours.from)}:00–${pad(hours.to)}:59`
}

export function routineCadenceLabel(cadence: RoutineScheduleWindow['cadence']): string {
  if (cadence.kind === 'time') {
    return translate('routines.atTime', 'At {{time}}', {
      time: formatAutomationScheduleTime(cadence.hour, cadence.minute)
    })
  }
  return cadence.minutes === 60
    ? translate('routines.hourly', 'Hourly')
    : translate('routines.everyMinutes', 'Every {{minutes}} min', { minutes: cadence.minutes })
}

/** The full window sentence, e.g. "Every 30 min · Mon–Fri · 09:00–17:59". */
export function describeRoutineWindow(window: RoutineScheduleWindow): string {
  return [
    routineCadenceLabel(window.cadence),
    describeRoutineDays(window.days),
    window.cadence.kind === 'interval' ? describeRoutineHours(window.hours) : null
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/**
 * The row caption for a cron with an allowed-days or allowed-hours window. Null when the
 * plain schedule label already says it all (every N min, hourly, daily, weekdays, weekly).
 */
export function describeRoutineWindowSchedule(cron: string): string | null {
  const window = parseRoutineWindowCron(cron)
  if (!window) {
    return null
  }
  if (window.cadence.kind === 'interval') {
    return isEveryRoutineDay(window.days) && isAllDayRoutineHours(window.hours)
      ? null
      : describeRoutineWindow(window)
  }
  return routineWindowPreset(window) === 'daily' && !isEveryRoutineDay(window.days)
    ? describeRoutineWindow(window)
    : null
}
