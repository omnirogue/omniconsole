import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handoffQueue } from '../../shared/console-handoff-contract'
import { consoleHandoffClient as client } from './console-handoff-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow } from './console-workflow-transport'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const thread = {
  id: 'hth_sample',
  board_task_id: 'btk_sample01',
  author_employee_id: 'emp_one',
  recipient_employee_id: 'emp_two',
  title: 'Review proposal',
  state: 'open',
  action: 'review',
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-10T21:00:00Z'
}
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: () => true
    }
  } as never)
})

describe('handoff queue views', () => {
  it("asks for the reader's own sent requests and keeps the next cursor", async () => {
    reply({ assignee: 'emp_one', view: 'sent', next_cursor: 'page_2', threads: [thread] })
    const result = await client.list({ view: 'sent', cursor: 'page_1' })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://console.test/api/gtd/hub/api/handoffs?view=sent&cursor=page_1'
    )
    expect(result).toMatchObject({ ok: true, data: { view: 'sent', next_cursor: 'page_2' } })
  })

  it('keeps the existing received views unchanged', async () => {
    reply({ assignee: 'emp_two', threads: [] })
    reply({ assignee: 'emp_two', threads: [] })
    await client.list()
    await client.list({ state: 'resolved' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.test/api/gtd/hub/api/handoffs?view=attention',
      'https://console.test/api/gtd/hub/api/handoffs?state=resolved'
    ])
  })

  it('refuses a cursor that could carry query syntax before any request', async () => {
    const result = await client.list({ view: 'sent', cursor: 'a&assignee=emp_two' })
    expect(result).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/api/gtd/hub/api/handoffs?view=sent&state=open&cursor=page_3',
    '/api/gtd/hub/api/handoffs?state=replied&cursor=abc',
    '/api/gtd/hub/api/handoffs?view=attention&cursor=abc'
  ])('lets the transport carry the queue shape %s', async (path) => {
    reply({ assignee: 'emp_one', threads: [] })
    expect(await requestConsoleWorkflow(path, 'GET', handoffQueue)).toMatchObject({ ok: true })
  })

  it.each([
    '/api/gtd/hub/api/handoffs',
    '/api/gtd/hub/api/handoffs?',
    '/api/gtd/hub/api/handoffs?view=sent&assignee=emp_two',
    '/api/gtd/hub/api/handoffs?cursor=abc&view=sent',
    '/api/gtd/hub/api/handoffs?view=everyone'
  ])('refuses %s at the transport before any request', async (path) => {
    expect(await requestConsoleWorkflow(path, 'GET', handoffQueue)).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the unread count the hub reports on each thread', async () => {
    reply({ assignee: 'emp_one', threads: [{ ...thread, unread_entries: 2 }] })
    const result = await client.list({ view: 'sent' })
    expect(result).toMatchObject({ ok: true, data: { threads: [{ unread_entries: 2 }] } })
  })

  it("carries the code that names a refused view: the hub's own and the console read table's tag", async () => {
    reply({ error: { code: 'invalid_view', message: 'A handoff list is received' } }, 422)
    reply(
      { detail: 'a query value is not shaped as the hub expects', tag: 'hub-read-invalid' },
      422
    )
    expect(await client.list({ view: 'sent' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_view', status: 422 }
    })
    expect(await client.list({ view: 'sent' })).toMatchObject({
      ok: false,
      error: { code: 'hub-read-invalid', status: 422 }
    })
  })

  it('keeps a validation refusal without a code as a plain refusal', async () => {
    reply({ detail: [{ loc: ['query', 'cursor'], msg: 'too long' }] }, 422)
    expect(await client.list({ view: 'sent' })).toMatchObject({
      ok: false,
      error: { code: 'backoffice_refused', status: 422 }
    })
  })
})
