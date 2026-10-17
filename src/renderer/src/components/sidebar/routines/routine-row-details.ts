import type { Automation } from '../../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { routineScheduleLabel } from './routine-schedule-label'
import { describeRoutineWindowSchedule } from './routine-window-label'

/** What the row's glyph says: paused by hand, past its scheduled time, or waiting for it. */
export type RoutineRowState = 'paused' | 'due' | 'idle'

/** The one mark a one-line routine row shows at rest, by priority: due now, then paused. */
export type RoutineRowIndicatorKind = 'due' | 'paused'

export function routineRowState(automation: Automation, now = Date.now()): RoutineRowState {
  if (!automation.enabled) {
    return 'paused'
  }
  // Why: a scheduled time that has come and gone without the host moving nextRunAt on means the
  // routine is waiting to start (or its scheduler is away) — worth a mark, unlike an idle wait.
  return automation.nextRunAt <= now ? 'due' : 'idle'
}

export function routineRowIndicator(
  automation: Automation,
  now = Date.now()
): RoutineRowIndicatorKind | null {
  const state = routineRowState(automation, now)
  return state === 'idle' ? null : state
}

export function routineRowStateLabel(state: RoutineRowState): string {
  switch (state) {
    case 'paused':
      return translate('routines.statePaused', 'Paused — will not run until resumed.')
    case 'due':
      return translate('routines.stateDue', 'Due now — its scheduled time has come.')
    case 'idle':
      return translate('routines.stateActive', 'Active — runs on its schedule.')
  }
}

/** The schedule sentence a person reads for a routine: the window when it has one, else the plain label. */
export function routineScheduleSentence(automation: Automation): string {
  return describeRoutineWindowSchedule(automation.rrule) ?? routineScheduleLabel(automation.rrule)
}

/**
 * The lines a comfortable row prints under the name: the schedule (with "· Paused" when it will
 * not run) and, for an active routine with a time ahead, when it next runs.
 */
export function routineRowCaption(automation: Automation, now = Date.now()): string[] {
  const schedule = routineScheduleSentence(automation)
  const lines = [
    automation.enabled
      ? schedule
      : translate('routines.scheduleWhilePaused', '{{schedule}} · Paused', {
          schedule
        })
  ]
  if (automation.enabled && automation.nextRunAt > now) {
    lines.push(
      translate('routines.nextRun', 'Next {{time}}', {
        time: formatUiRelativeTime(automation.nextRunAt - now)
      })
    )
  }
  return lines
}

export function formatRoutineAbsoluteTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(value)
}

/**
 * The next run for the hover card: what to print and the exact time for its `title`. Null when
 * the routine is paused — there is no next run to promise.
 */
export function routineNextRunDetail(
  automation: Automation,
  now = Date.now()
): { text: string; title: string } | null {
  if (!automation.enabled) {
    return null
  }
  const absolute = formatRoutineAbsoluteTime(automation.nextRunAt)
  if (automation.nextRunAt <= now) {
    return { text: translate('routines.dueNow', 'Due now'), title: absolute }
  }
  return {
    text: formatUiRelativeTime(automation.nextRunAt - now),
    title: absolute
  }
}
