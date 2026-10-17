import { beforeEach, expect, it, vi } from 'vitest'
import { archivePeerMessage } from './console-peer-message-archive'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
const person = {
  bearer: 'fixture-token',
  baseUrl: 'https://console.test',
  principal: 'fixture-person',
  isCurrent: current
}
const thread = {
  id: `pm_${'a'.repeat(24)}`,
  project_id: 'project_one',
  task_id: null,
  sender_session_id: 'session_a',
  recipient_session_id: 'session_b',
  sender_employee_id: 'emp_one',
  recipient_employee_id: 'emp_two',
  purpose: 'question',
  summary: 'Review the draft',
  state: 'queued',
  created_at: 1,
  delivered_at: null,
  replied_at: null,
  resolved_at: null,
  expires_at: null,
  reply: null
}
const input = { messageId: thread.id, archived: true, operationId: 'archive_12345678' }
const receipt = { message_id: thread.id, employee_id: 'emp_one', archived: true }
function reply(body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({ ok: true, data: person })
})

it.each(['emp_one', 'emp_two'])(
  'deletes only the signed participant copy for %s',
  async (employeeId) => {
    reply({ user: { employee_id: employeeId } })
    reply({ thread })
    reply({ ...receipt, employee_id: employeeId })
    expect(await archivePeerMessage(input)).toMatchObject({
      ok: true,
      data: { archived: true, employee_id: employeeId }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.test/api/me',
      `https://console.test/api/gtd/hub/api/session-peers/messages/${thread.id}`,
      `https://console.test/api/gtd/hub/api/session-peers/messages/${thread.id}/archive`
    ])
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({
      archived: true,
      operation_id: input.operationId
    })
  }
)

it('refuses a readable message for a nonparticipant before mutation', async () => {
  reply({ user: { employee_id: 'emp_admin' } })
  reply({ thread })
  expect(await archivePeerMessage(input)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each([
  { employee_id: 'emp_other' },
  { message_id: `pm_${'b'.repeat(24)}` },
  { archived: 'true' }
])('rejects an unconfirmed receipt %j', async (patch) => {
  reply({ user: { employee_id: 'emp_one' } })
  reply({ thread })
  reply({ ...receipt, ...patch })
  expect(await archivePeerMessage(input)).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})

it('keeps effective restored state from a stale deletion replay', async () => {
  reply({ user: { employee_id: 'emp_one' } })
  reply({ thread })
  reply({ ...receipt, archived: false, replayed: true })
  expect(await archivePeerMessage(input)).toMatchObject({
    ok: true,
    data: { archived: false, replayed: true }
  })
})

it('does not report success after the account changes during mutation', async () => {
  reply({ user: { employee_id: 'emp_one' } })
  reply({ thread })
  fetchMock.mockImplementationOnce(async () => {
    current.mockReturnValue(false)
    return new Response(JSON.stringify(receipt))
  })
  expect(await archivePeerMessage(input)).toMatchObject({
    ok: false,
    error: { code: 'connection_changed' }
  })
})
