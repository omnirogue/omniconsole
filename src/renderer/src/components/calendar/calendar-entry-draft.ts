import { translate } from '@/i18n/i18n'
import type { CalendarEntry } from '../../../../shared/console-calendar-contract'
import type { CalendarOptions } from './CalendarEntryOptions'
import { localDateTime, shiftDay } from './calendar-dates'

export function entryEndInput(entry: CalendarEntry | null, createDay: string): string {
  if (!entry) {
    return `${createDay}T10:00`
  }
  if (!entry.ends_at) {
    return ''
  }
  return localDateTime(
    entry.all_day ? new Date(Date.parse(entry.ends_at) - 1).toISOString() : entry.ends_at
  )
}

export function calendarEntryPatch(draft: {
  title: string
  starts: string
  ends: string
  allDay: boolean
  participants: string[]
  details: string
  options: CalendarOptions
}) {
  const { title, starts, ends, allDay, participants, details, options } = draft
  const startDate = new Date(allDay ? `${starts.slice(0, 10)}T00:00` : starts)
  const endDate = allDay
    ? new Date(`${shiftDay((ends || starts).slice(0, 10), 1)}T00:00`)
    : ends
      ? new Date(ends)
      : null
  if (
    !Number.isFinite(startDate.getTime()) ||
    (endDate && (!Number.isFinite(endDate.getTime()) || endDate <= startDate))
  ) {
    throw new Error(
      translate('calendar.invalidRange', 'Choose a valid start and an end after the start.')
    )
  }
  const leads = options.leads.trim()
    ? options.leads.split(',').map((value) => Number(value.trim()))
    : []
  if (
    leads.some((value) => !Number.isInteger(value) || value < 1 || value > 10080) ||
    leads.length > 20
  ) {
    throw new Error(
      translate(
        'calendar.invalidLeads',
        'Use up to 20 reminder times between 1 and 10,080 minutes.'
      )
    )
  }
  return {
    title: title.trim(),
    starts_at: startDate.toISOString(),
    ends_at: endDate?.toISOString() ?? null,
    all_day: allDay,
    participants,
    details,
    location: options.location.trim() || null,
    meeting_url: options.url.trim() || null,
    visibility: options.visibility,
    reminder_leads: [...new Set(leads)],
    recurrence_rule: options.recurrence || null
  }
}
