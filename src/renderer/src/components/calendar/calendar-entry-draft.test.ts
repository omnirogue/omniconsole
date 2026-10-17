import { expect, it } from 'vitest'
import { calendarEntry } from '../../../../shared/console-calendar-contract'
import { calendarEntryPatch, entryEndInput } from './calendar-entry-draft'
import { localDateTime } from './calendar-dates'

const options = {
  location: '',
  url: '',
  visibility: 'personal' as const,
  recurrence: '',
  leads: '15'
}

it('editing an all-day appointment preserves its exclusive end across DST', () => {
  const entry = calendarEntry.parse({
    id: 'agd_1234',
    kind: 'meeting',
    title: 'All-day review',
    all_day: true,
    starts_at: new Date(2026, 2, 8).toISOString(),
    ends_at: new Date(2026, 2, 9).toISOString()
  })
  const patch = calendarEntryPatch({
    title: entry.title ?? '',
    starts: localDateTime(entry.starts_at),
    ends: entryEndInput(entry, ''),
    allDay: true,
    participants: [],
    details: '',
    options
  })
  expect(patch.starts_at).toBe(entry.starts_at)
  expect(patch.ends_at).toBe(entry.ends_at)
})

it('rejects reversed times and invalid reminders without issuing a mutation', () => {
  const draft = {
    title: 'Review',
    starts: '2026-09-15T15:00',
    ends: '2026-09-15T14:00',
    allDay: false,
    participants: [],
    details: '',
    options
  }
  expect(() => calendarEntryPatch(draft)).toThrow('end after the start')
  expect(() =>
    calendarEntryPatch({ ...draft, ends: '', options: { ...options, leads: '-1' } })
  ).toThrow('reminder times')
})

it('keeps explicit clears and selected participants in the saved patch', () => {
  const patch = calendarEntryPatch({
    title: 'Review',
    starts: '2026-09-15T15:00',
    ends: '',
    allDay: false,
    participants: ['emp_alba'],
    details: '',
    options: { ...options, leads: '' }
  })
  expect(patch).toMatchObject({
    ends_at: null,
    meeting_url: null,
    location: null,
    recurrence_rule: null,
    participants: ['emp_alba'],
    reminder_leads: []
  })
})
