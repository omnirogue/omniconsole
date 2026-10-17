import { z } from 'zod'
import {
  calendarActionRequest,
  calendarCreateRequest,
  calendarEntry,
  calendarFeed,
  calendarReadRequest,
  calendarUpdateRequest,
  projectDueDateRequest,
  type ConsoleCalendarApi
} from '../../shared/console-calendar-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const agendaPath = '/api/gtd/hub/api/agenda'

export const consoleCalendarClient: ConsoleCalendarApi = {
  listCalendar: (args) =>
    validated(args, calendarReadRequest, ({ from, to, company, employee }) => {
      const query = new URLSearchParams({
        frm: from,
        to,
        include: 'entries,tasks,projects',
        include_cancelled: 'true'
      })
      if (company) {
        query.set('company', company)
      }
      if (employee) {
        query.set('employee', employee)
      }
      return request(`${agendaPath}/calendar?${query.toString()}`, 'GET', calendarFeed)
    }),
  createCalendarEntry: (args) =>
    validated(args, calendarCreateRequest, (body) =>
      request(
        agendaPath,
        'POST',
        calendarEntry,
        Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null))
      )
    ),
  updateCalendarEntry: (args) =>
    validated(args, calendarUpdateRequest, ({ entryId, patch }) =>
      request(
        `${agendaPath}/${entryId}`,
        'PATCH',
        calendarEntry.refine((entry) => entry.id === entryId),
        patch
      )
    ),
  calendarEntryAction: (args) =>
    validated(args, calendarActionRequest, ({ entryId, action }) =>
      request(
        `${agendaPath}/${entryId}/${action}`,
        'POST',
        calendarEntry.refine(
          (entry) =>
            entry.id === entryId && entry.status === (action === 'cancel' ? 'cancelled' : 'done')
        ),
        {}
      )
    ),
  updateProjectDueDate: (args) =>
    validated(args, projectDueDateRequest, ({ projectId, dueDate }) =>
      request(
        `/api/gtd/hub/api/projects/${encodeURIComponent(projectId)}`,
        'PATCH',
        z.object({ id: z.literal(projectId), due_date: z.literal(dueDate) }),
        { due_date: dueDate }
      )
    )
}
