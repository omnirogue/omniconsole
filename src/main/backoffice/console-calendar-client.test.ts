import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleCalendarClient as client } from './console-calendar-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
const entry = {
  id: 'agd_calendar123',
  kind: 'meeting',
  title: 'Project review',
  starts_at: '2026-09-15T14:00:00-04:00',
  ends_at: '2026-09-15T15:00:00-04:00',
  status: 'scheduled',
  visibility: 'personal',
  owner_employee_id: 'emp_other',
  participants: [{ employee_id: 'emp_sal', name: 'Sal' }]
}
function reply(value: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'calendar-person',
      baseUrl: 'https://console.test',
      principal: 'emp_sal',
      isCurrent: current
    }
  } as never)
})

describe('calendar signed-person bridge', () => {
  it('creates an appointment through the canonical write and omits unset optional create fields', async () => {
    reply(entry, 201)
    expect(
      await client.createCalendarEntry({
        company: 'omnirogue',
        kind: 'meeting',
        title: 'Project review',
        starts_at: entry.starts_at,
        participants: ['emp_sal'],
        ends_at: null,
        meeting_url: null,
        location: null,
        recurrence_rule: null
      })
    ).toMatchObject({ ok: true, data: { id: entry.id } })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://console.test/api/gtd/hub/api/agenda',
      expect.objectContaining({ method: 'POST' })
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      company: 'omnirogue',
      kind: 'meeting',
      title: 'Project review',
      starts_at: entry.starts_at,
      participants: ['emp_sal']
    })
  })

  it('reads all three layers and preserves appointments granted through participation and partial failures', async () => {
    reply({
      entries: [entry],
      tasks: [],
      projects: [],
      overlay_errors: [{ overlay: 'tasks', error: 'Unavailable' }]
    })
    const result = await client.listCalendar({
      from: '2026-09-01',
      to: '2026-09-30',
      company: 'omnirogue',
      employee: 'emp_sal'
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        projects_available: true,
        entries: [
          {
            id: entry.id,
            owner_employee_id: 'emp_other',
            participants: [{ employee_id: 'emp_sal' }]
          }
        ],
        overlay_errors: [{ overlay: 'tasks', error: 'Unavailable' }]
      }
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://console.test/api/gtd/hub/api/agenda/calendar?frm=2026-09-01&to=2026-09-30&include=entries%2Ctasks%2Cprojects&include_cancelled=true&company=omnirogue&employee=emp_sal',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer calendar-person' })
      })
    )
  })

  it('distinguishes an older hub without project deadlines from an empty project calendar', async () => {
    reply({ entries: [], tasks: [] })
    expect(await client.listCalendar({ from: '2026-09-01', to: '2026-09-30' })).toMatchObject({
      ok: true,
      data: { projects: [], projects_available: false }
    })
  })

  it.each([
    { from: '2026-02-30', to: '2026-03-10' },
    { from: '2026-09-15', to: '2026-09-14' },
    { from: '2026-01-01', to: '2026-12-31' },
    { from: '2026-09-01', to: '2026-09-30', company: 'a&employee=emp_other' }
  ])('rejects invalid or unbounded calendar scopes before transport', async (range) => {
    expect(await client.listCalendar(range)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discards calendar data if the signed-in person changes while the response arrives', async () => {
    fetchMock.mockImplementationOnce(async () => {
      current.mockReturnValue(false)
      return new Response(JSON.stringify({ entries: [entry], tasks: [], projects: [] }))
    })
    expect(await client.listCalendar({ from: '2026-09-01', to: '2026-09-30' })).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })

  it('persists appointment edits and explicit clears to the existing agenda row', async () => {
    reply({ ...entry, ends_at: null, meeting_url: null, recurrence_rule: null })
    expect(
      await client.updateCalendarEntry({
        entryId: entry.id,
        patch: {
          ends_at: null,
          meeting_url: null,
          recurrence_rule: null,
          participants: ['emp_sal']
        }
      })
    ).toMatchObject({ ok: true, data: { id: entry.id, ends_at: null } })
    expect(fetchMock).toHaveBeenCalledWith(
      `https://console.test/api/gtd/hub/api/agenda/${entry.id}`,
      expect.objectContaining({ method: 'PATCH' })
    )
    const body = fetchMock.mock.calls[0]?.[1]?.body
    expect(JSON.parse(String(body))).toEqual({
      ends_at: null,
      participants: ['emp_sal'],
      meeting_url: null,
      recurrence_rule: null
    })
  })

  it('requires the returned project deadline to confirm the requested date was saved', async () => {
    reply({ id: 'project_calendar', due_date: '2026-09-17' })
    expect(
      await client.updateProjectDueDate({ projectId: 'project_calendar', dueDate: '2026-09-18' })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    reply({ id: 'project_calendar', due_date: null })
    expect(
      await client.updateProjectDueDate({ projectId: 'project_calendar', dueDate: null })
    ).toEqual({
      ok: true,
      data: { id: 'project_calendar', due_date: null }
    })
  })

  it('does not turn a refused read into an empty calendar', async () => {
    reply({ ok: false, code: 'forbidden', reason: 'Company access required' }, 403)
    const result = await client.listCalendar({ from: '2026-09-01', to: '2026-09-30' })
    expect(result).toMatchObject({ ok: false, error: { status: 403 } })
  })
})
