import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'

const nullableText = z.string().nullable().optional()
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`)
    return (
      value.slice(0, 4) !== '0000' &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
  }, 'Use a real date in YYYY-MM-DD format.')
const moment = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  .refine(
    (value) =>
      calendarDate.safeParse(value.slice(0, 10)).success && Number.isFinite(Date.parse(value)),
    'Use a real timestamp with a timezone.'
  )
const entryId = z.string().regex(/^agd_[A-Za-z0-9]{4,64}$/)
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const employeeId = z.string().regex(/^emp_[A-Za-z0-9_-]{1,128}$/)
const meetingUrl = z
  .string()
  .max(2000)
  .url()
  .regex(/^https?:\/\//)
const visibility = z.enum(['company', 'team', 'personal'])
const recurrence = z
  .string()
  .max(500)
  .regex(
    /^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]{0,2}|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{8}(T[0-9]{6}Z)?))*$/
  )
const participants = z.array(employeeId).max(100)
const reminderLeads = z.array(z.number().int().min(1).max(10080)).max(20)

export const calendarEntry = z.object({
  id: entryId,
  org_company_id: nullableText,
  company_slug: nullableText,
  org_unit_id: nullableText,
  kind: z.enum(['meeting', 'reminder']),
  title: nullableText,
  starts_at: moment,
  ends_at: moment.nullable().optional(),
  all_day: z.boolean().default(false),
  status: z.enum(['scheduled', 'done', 'cancelled']).default('scheduled'),
  participants: z
    .array(
      z.object({
        employee_id: employeeId,
        name: nullableText,
        email: nullableText
      })
    )
    .default([]),
  visibility: visibility.default('company'),
  owner_employee_id: nullableText,
  details: nullableText,
  meeting_url: nullableText,
  location: nullableText,
  recurrence_rule: nullableText,
  recurrence_parent_id: nullableText,
  reminder_leads: z.array(z.number()).default([]),
  reminders: z.array(z.string()).default([]),
  notes: z
    .array(
      z.object({
        text: z.string(),
        at: nullableText,
        author_employee_id: nullableText
      })
    )
    .default([]),
  external_attendees: z.array(z.object({ email: z.string(), name: nullableText })).default([]),
  gcal: z.object({ error: nullableText, synced_at: nullableText }).optional(),
  created_by: nullableText,
  started_at: nullableText,
  completed_at: nullableText,
  updated_at: nullableText
})
export const calendarTask = z.object({
  id: z.string().min(1),
  title: z.string(),
  due_date: z.union([calendarDate, moment]),
  kind: z.literal('task'),
  owner_employee_id: nullableText,
  company_slug: nullableText,
  project_id: nullableText,
  status: nullableText
})
export const calendarProject = z.object({
  id: projectId,
  title: z.string(),
  due_date: calendarDate,
  kind: z.literal('project'),
  owner_employee_id: nullableText,
  company_slug: nullableText,
  status: nullableText
})
export const calendarFeed = z
  .object({
    entries: z.array(calendarEntry),
    tasks: z.array(calendarTask),
    projects: z.array(calendarProject).optional(),
    agent: z
      .array(z.object({ kind: z.string(), at: z.string(), label: z.string(), ref: nullableText }))
      .default([]),
    overlay_errors: z.array(z.object({ overlay: z.string(), error: z.string() })).default([]),
    generated_at: nullableText
  })
  .transform((feed) => ({
    ...feed,
    projects: feed.projects ?? [],
    projects_available: feed.projects !== undefined
  }))
export const calendarReadRequest = z
  .object({
    from: calendarDate,
    to: calendarDate,
    company: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    employee: employeeId.optional()
  })
  .strict()
  .refine(({ from, to }) => {
    const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000
    return days >= 0 && days <= 62
  }, 'Choose a forward calendar range of at most 62 days.')

const editable = {
  title: z.string().trim().min(1).max(300),
  starts_at: moment,
  ends_at: moment.nullable().optional(),
  all_day: z.boolean().optional(),
  participants: participants.optional(),
  details: z.string().max(4000).optional(),
  meeting_url: meetingUrl.nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  visibility: visibility.optional(),
  reminder_leads: reminderLeads.optional(),
  recurrence_rule: recurrence.nullable().optional()
}
export const calendarCreateRequest = z
  .object({
    ...editable,
    company: z.string().trim().min(1).max(100),
    kind: z.enum(['meeting', 'reminder'])
  })
  .strict()
export const calendarPatch = z
  .object(editable)
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Choose at least one appointment field to update.'
  )
export const calendarUpdateRequest = z.object({ entryId, patch: calendarPatch }).strict()
export const calendarActionRequest = z
  .object({
    entryId,
    action: z.enum(['cancel', 'complete'])
  })
  .strict()
export const projectDueDateRequest = z
  .object({ projectId, dueDate: calendarDate.nullable() })
  .strict()

export type CalendarEntry = z.infer<typeof calendarEntry>
export type CalendarTask = z.infer<typeof calendarTask>
export type CalendarProject = z.infer<typeof calendarProject>
export type ConsoleCalendarFeed = z.infer<typeof calendarFeed>
export type CalendarCreateRequest = z.infer<typeof calendarCreateRequest>
export type CalendarUpdateRequest = z.infer<typeof calendarUpdateRequest>
export type CalendarReadRequest = z.infer<typeof calendarReadRequest>
export type ConsoleCalendarApi = {
  listCalendar(request: CalendarReadRequest): Promise<ConsoleWorkflowResult<ConsoleCalendarFeed>>
  createCalendarEntry(request: CalendarCreateRequest): Promise<ConsoleWorkflowResult<CalendarEntry>>
  updateCalendarEntry(request: CalendarUpdateRequest): Promise<ConsoleWorkflowResult<CalendarEntry>>
  calendarEntryAction(
    request: z.infer<typeof calendarActionRequest>
  ): Promise<ConsoleWorkflowResult<CalendarEntry>>
  updateProjectDueDate(
    request: z.infer<typeof projectDueDateRequest>
  ): Promise<ConsoleWorkflowResult<{ id: string; due_date: string | null }>>
}
