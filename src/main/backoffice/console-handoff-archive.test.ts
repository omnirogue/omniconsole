import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleHandoffClient as client } from './console-handoff-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
const person = {
  bearer: 'test-person-only',
  baseUrl: 'https://console.test',
  principal: 'test-person',
  isCurrent: current
}
const thread = {
  id: 'hth_sample',
  board_task_id: null,
  author_employee_id: 'emp_one',
  recipient_employee_id: 'emp_two',
  title: 'A file for review',
  state: 'open',
  action: null,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-14T20:00:00Z'
}
const detail = { thread, files: [], reviews: [], entries: [] }
const input = { threadId: thread.id, archived: true, operationId: 'archive_12345678' }
const receipt = { thread_id: thread.id, employee_id: 'emp_one', archived: true }
function reply(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function viewer(employeeId = 'emp_one'): void {
  reply({ user: { employee_id: employeeId } })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({ ok: true, data: person })
})

describe('personal handoff archive', () => {
  it.each(['emp_one', 'emp_two'])('archives only the signed participant %s', async (employeeId) => {
    viewer(employeeId)
    reply(detail)
    reply({ ...receipt, employee_id: employeeId })
    expect(await client.archive(input)).toMatchObject({
      ok: true,
      data: { ...receipt, employee_id: employeeId }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.test/api/me',
      `https://console.test/api/gtd/hub/api/handoffs/${thread.id}`,
      `https://console.test/api/gtd/hub/api/handoffs/${thread.id}/archive`
    ])
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({
      archived: true,
      idempotency_key: input.operationId
    })
  })

  it('restores through the same endpoint with a new saved operation', async () => {
    viewer()
    reply(detail)
    reply({ ...receipt, archived: false })
    expect(await client.archive({ ...input, archived: false })).toMatchObject({
      ok: true,
      data: { archived: false }
    })
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toHaveProperty(
      'archived',
      false
    )
  })

  it('keeps the effective state when an old archive replay follows a new reply', async () => {
    viewer()
    reply(detail)
    reply({ ...receipt, archived: false, replayed: true })
    expect(await client.archive(input)).toMatchObject({
      ok: true,
      data: { archived: false, replayed: true }
    })
  })

  it('refuses an unrelated employee before writing, even if the detail is readable', async () => {
    viewer('emp_admin')
    reply(detail)
    expect(await client.archive(input)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { thread: { ...thread, id: 'hth_other' }, code: 'invalid_response' },
    { thread: { ...thread, author_employee_id: 'emp_other' }, code: 'forbidden' }
  ])('refuses a mismatched thread before archive', async (changed) => {
    viewer()
    reply({ ...detail, thread: changed.thread })
    expect(await client.archive(input)).toMatchObject({ ok: false, error: { code: changed.code } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([{ thread_id: 'hth_other' }, { employee_id: 'emp_other' }, { archived: 'true' }])(
    'rejects an unverified archive receipt %j',
    async (patch) => {
      viewer()
      reply(detail)
      reply({ ...receipt, ...patch })
      expect(await client.archive(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
  )

  it('refuses a missing employee binding before reading or changing a handoff', async () => {
    reply({ user: { employee_id: null } })
    expect(await client.archive(input)).toMatchObject({
      ok: false,
      error: { code: 'identity_unavailable' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not carry an archive into a different signed account', async () => {
    viewer()
    vi.mocked(captureConsoleWorkflowPerson)
      .mockResolvedValueOnce({ ok: true, data: person })
      .mockResolvedValueOnce({ ok: true, data: person })
      .mockResolvedValueOnce({ ok: true, data: { ...person, principal: 'another-person' } })
    expect(await client.archive(input)).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not claim success after the profile changes while a write is in flight', async () => {
    viewer()
    reply(detail)
    fetchMock.mockImplementationOnce(async () => {
      current.mockReturnValue(false)
      return new Response(JSON.stringify(receipt))
    })
    expect(await client.archive(input)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })

  it.each([
    { threadId: 'hth_sample/archive?employee_id=emp_other' },
    { operationId: 'x' },
    { archived: 'true' },
    { employeeId: 'emp_other' }
  ])('refuses malformed or caller-selected identity %j before capture', async (patch) => {
    expect(await client.archive({ ...input, ...patch } as never)).toMatchObject({ ok: false })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('archived handoff queue', () => {
  it('reads the canonical personal archive with its pagination cursor', async () => {
    viewer()
    reply({
      assignee: 'emp_one',
      view: 'archived',
      next_cursor: 'page_2',
      threads: [{ ...thread, archived: true }]
    })
    expect(await client.list({ view: 'archived', state: 'open', cursor: 'page_1' })).toMatchObject({
      ok: true,
      data: { view: 'archived', next_cursor: 'page_2', threads: [{ archived: true }] }
    })
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://console.test/api/gtd/hub/api/handoffs?view=archived&state=open&cursor=page_1'
    )
  })

  it.each([
    { view: undefined },
    { view: 'sent' },
    { assignee: 'emp_two' },
    { threads: [{ ...thread, author_employee_id: 'emp_other' }] }
  ])('refuses an ignored archive view or another employee queue %j', async (patch) => {
    viewer()
    reply({ assignee: 'emp_one', view: 'archived', threads: [], ...patch })
    expect(await client.list({ view: 'archived' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })
})
