import { buildAutomationCronSchedule } from './automation-schedule-occurrences'
import {
  getAutomationCronExpressionFields,
  parseCronExpression
} from './automation-schedule-parsing'

/**
 * The "when it runs" projection of a routine's cron: a cadence, the weekdays it
 * may run on, and (for intervals) the hours of the day it may run in. Everything
 * here is plain cron the scheduler already honours; nothing new crosses the wire.
 */

export const ROUTINE_INTERVAL_MINUTES = [5, 10, 15, 30, 60] as const
export type RoutineIntervalMinutes = (typeof ROUTINE_INTERVAL_MINUTES)[number]

export const ROUTINE_ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6]
export const ROUTINE_MONDAY_TO_FRIDAY: readonly number[] = [1, 2, 3, 4, 5]
export const ROUTINE_ALL_HOURS = { from: 0, to: 23 } as const

export type RoutineRunCadence =
  | { kind: 'interval'; minutes: RoutineIntervalMinutes }
  | { kind: 'time'; hour: number; minute: number }

export type RoutineScheduleWindow = {
  cadence: RoutineRunCadence
  /** Allowed weekdays in cron numbering (0 = Sunday), ascending; all seven means every day. */
  days: readonly number[]
  /** Allowed hours for interval cadences, inclusive; 0–23 means all day. */
  hours: { from: number; to: number }
}

export type RoutineWindowPreset = 'interval' | 'daily' | 'weekdays' | 'weekly'

export type RoutineWindowProblem = 'no-days' | 'hours-order'

export function normalizeRoutineDays(days: Iterable<number>): number[] {
  return [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
}

export function sameRoutineDays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((day, index) => day === right[index])
}

export function isEveryRoutineDay(days: readonly number[]): boolean {
  return sameRoutineDays(normalizeRoutineDays(days), ROUTINE_ALL_DAYS)
}

export function isAllDayRoutineHours(hours: RoutineScheduleWindow['hours']): boolean {
  return hours.from === ROUTINE_ALL_HOURS.from && hours.to === ROUTINE_ALL_HOURS.to
}

/** How the picker names a window: intervals stay intervals; a clock time reads by its days. */
export function routineWindowPreset(window: RoutineScheduleWindow): RoutineWindowPreset {
  if (window.cadence.kind === 'interval') {
    return 'interval'
  }
  const days = normalizeRoutineDays(window.days)
  if (sameRoutineDays(days, ROUTINE_MONDAY_TO_FRIDAY)) {
    return 'weekdays'
  }
  return days.length === 1 ? 'weekly' : 'daily'
}

export function routineWindowProblem(window: RoutineScheduleWindow): RoutineWindowProblem | null {
  if (normalizeRoutineDays(window.days).length === 0) {
    return 'no-days'
  }
  if (window.cadence.kind === 'interval' && window.hours.from > window.hours.to) {
    return 'hours-order'
  }
  return null
}

/** Ascending runs of consecutive numbers, e.g. [1,2,3,5] → [[1,3],[5,5]]. */
export function contiguousRuns(values: readonly number[]): [number, number][] {
  const runs: [number, number][] = []
  for (const value of values) {
    const last = runs.at(-1)
    if (last && last[1] === value - 1) {
      last[1] = value
    } else {
      runs.push([value, value])
    }
  }
  return runs
}

/** Cron day-of-week field: `*` for every day, contiguous days collapsed (`1-5`, `1-3,6`). */
export function formatRoutineCronDays(days: readonly number[]): string {
  const normalized = normalizeRoutineDays(days)
  if (normalized.length === 0 || isEveryRoutineDay(normalized)) {
    return '*'
  }
  return contiguousRuns(normalized)
    .map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`))
    .join(',')
}

function formatRoutineCronHours(hours: RoutineScheduleWindow['hours']): string {
  if (isAllDayRoutineHours(hours)) {
    return '*'
  }
  return hours.from === hours.to ? `${hours.from}` : `${hours.from}-${hours.to}`
}

export function buildRoutineWindowCron(window: RoutineScheduleWindow): string {
  const days = formatRoutineCronDays(window.days)
  if (window.cadence.kind === 'interval') {
    // Why: sixty is not a valid step in the minute field; "every hour" is minute zero of each hour.
    const minute = window.cadence.minutes === 60 ? '0' : `*/${window.cadence.minutes}`
    return `${minute} ${formatRoutineCronHours(window.hours)} * * ${days}`
  }
  const fields = getAutomationCronExpressionFields(
    buildAutomationCronSchedule({
      preset: 'daily',
      hour: window.cadence.hour,
      minute: window.cadence.minute
    })
  )
  fields[4] = days
  return fields.join(' ')
}

function contiguousHours(hours: ReadonlySet<number>): RoutineScheduleWindow['hours'] | null {
  const sorted = [...hours].sort((a, b) => a - b)
  const from = sorted[0]
  const to = sorted.at(-1)
  if (from === undefined || to === undefined || to - from + 1 !== sorted.length) {
    return null
  }
  return { from, to }
}

function intervalMinutes(minutes: ReadonlySet<number>): RoutineIntervalMinutes | null {
  for (const step of ROUTINE_INTERVAL_MINUTES) {
    if (step === 60) {
      continue
    }
    if (minutes.size === 60 / step && [...minutes].every((minute) => minute % step === 0)) {
      return step
    }
  }
  return null
}

/**
 * Read a cron back into the picker's controls, or null when it says something the
 * controls cannot (a specific date, a scattered hour set, `5 * * * *`, …).
 */
export function parseRoutineWindowCron(cron: string): RoutineScheduleWindow | null {
  let parsed: ReturnType<typeof parseCronExpression>
  try {
    parsed = parseCronExpression(cron.trim())
  } catch {
    return null
  }
  if (parsed.dayOfMonthRestricted || parsed.months.size !== 12) {
    return null
  }
  const days = normalizeRoutineDays(parsed.daysOfWeek)
  const hours = contiguousHours(parsed.hours)
  if (!hours) {
    return null
  }
  if (parsed.minutes.size === 1) {
    const minute = [...parsed.minutes][0]!
    if (parsed.hours.size === 1) {
      return { cadence: { kind: 'time', hour: hours.from, minute }, days, hours: ROUTINE_ALL_HOURS }
    }
    return minute === 0 ? { cadence: { kind: 'interval', minutes: 60 }, days, hours } : null
  }
  const minutes = intervalMinutes(parsed.minutes)
  return minutes === null ? null : { cadence: { kind: 'interval', minutes }, days, hours }
}
