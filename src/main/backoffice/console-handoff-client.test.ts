import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { consoleHandoffClient as client } from './console-handoff-client'
import { downloadHandoffFile, uploadHandoffFile } from './console-handoff-files'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
const digest = 'a'.repeat(64)
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
const send = {
  taskId: thread.board_task_id,
  recipient: 'emp_two',
  title: thread.title,
  action: 'review' as const,
  note: 'Review the attached original.',
  fileVersions: [{ path: 'uploads/report.docx', sha256: digest }],
  operationId: 'request_12345678'
}
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: current
    }
  } as never)
})
describe('native handoff broker contract', () => {
  it('refuses a send receipt addressed to somebody other than the selected employee', async () => {
    reply({ thread: { ...thread, recipient_employee_id: 'emp_test' } })
    expect(await client.send(send)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toHaveProperty(
      'recipient_employee_id',
      send.recipient
    )
  })

  it('checks the selected employee on a message without a task too', async () => {
    reply({ thread: { ...thread, board_task_id: null, recipient_employee_id: 'emp_test' } })
    expect(
      await client.sendCardless({
        title: 'Question for Uma',
        note: 'Can you review this?',
        recipient: 'emp_uma',
        operationId: 'question_12345678',
        attachments: []
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
  })

  it('keeps active humans as recipients and tolerates roster rows with no kind', async () => {
    reply({}, 404)
    reply({ detail: 'admin only', tag: 'rbac-admin-only' }, 403)
    reply({
      employees: [
        { id: 'emp_sal', name: 'Sal', status: 'active', kind: 'human', role: 'CEO ' },
        {
          id: 'emp_unattributed',
          name: 'Unattributed (escalation audit)',
          status: 'active',
          kind: null
        },
        { id: 'emp_bot', name: 'Bot', status: 'active', kind: 'agent' },
        { id: 'emp_old', name: 'Old', status: 'inactive', kind: 'human' }
      ]
    })
    const result = await client.recipients()
    expect(result.ok).toBe(true)
    expect(result.ok && result.data).toHaveProperty('peopleSource', 'employees')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.test/api/work/recipients',
      'https://console.test/api/admin/users',
      'https://console.test/api/gtd/hub/api/employees'
    ])
    expect(result.ok && result.data.employees).toEqual([
      { id: 'emp_sal', name: 'Sal', status: 'active', kind: 'human', role: 'CEO' }
    ])
  })

  it('reads the sign-in directory through the admin door while the recipients route is missing', async () => {
    reply({}, 404)
    reply({
      ok: true,
      users: [
        {
          clerk_user_id: 'u1',
          role: 'admin',
          employee_id: 'emp_sal',
          name: 'Sal',
          email: 's@x.io'
        },
        { clerk_user_id: 'u2', role: 'member', employee_id: 'emp_uma', name: '', email: 'u@x.io' },
        { clerk_user_id: 'u3', role: 'pending', employee_id: 'emp_new', name: 'New' },
        { clerk_user_id: 'u4', role: 'member', employee_id: null, name: 'Unlinked' },
        {
          clerk_user_id: 'u5',
          role: 'member',
          employee_id: 'emp_gone',
          name: 'Gone',
          missing_in_clerk: true
        },
        {
          clerk_user_id: 'u6',
          role: 'member',
          employee_id: 'emp_ops',
          name: 'Ops',
          companies: ['acme']
        }
      ],
      directory_available: true
    })
    expect(await client.recipients()).toEqual({
      ok: true,
      data: {
        employees: [
          { id: 'emp_sal', name: 'Sal' },
          { id: 'emp_uma', name: 'u@x.io' },
          { id: 'emp_ops', name: 'Ops', companies: ['acme'] }
        ],
        peopleSource: 'admin-directory'
      }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.test/api/work/recipients',
      'https://console.test/api/admin/users'
    ])
  })
  it('uses the authoritative directory without reading employees', async () => {
    reply({
      recipients: [
        {
          id: 'emp_one',
          name: 'One',
          companies: ['acme'],
          photo_url: 'https://example.com/one.jpg'
        }
      ]
    })
    expect(await client.recipients()).toMatchObject({
      ok: true,
      data: {
        employees: [
          { id: 'emp_one', companies: ['acme'], photo_url: 'https://example.com/one.jpg' }
        ],
        peopleSource: 'directory'
      }
    })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://console.test/api/work/recipients')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 500])('does not fall back on HTTP %s', async (status) => {
    reply(status === 500 ? {} : { code: 'capability_unavailable' }, status)
    expect(await client.recipients()).toMatchObject({ ok: false, error: { status } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    [503, {}],
    [500, { tag: 'rbac_store_unavailable' }],
    [500, { tag: 'rbac-store-unavailable' }]
  ])(
    'falls back when the RBAC store is down (%s) without asking the admin list',
    async (status, body) => {
      reply(body, status)
      reply({ employees: [] })
      expect(await client.recipients()).toMatchObject({
        ok: true,
        data: { employees: [], peopleSource: 'employees' }
      })
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://console.test/api/work/recipients',
        'https://console.test/api/gtd/hub/api/employees'
      ])
    }
  )
  it('falls back on an explicit not-served response', async () => {
    reply({ code: 'not_served' }, 501)
    reply({ detail: 'admin only', tag: 'rbac-admin-only' }, 403)
    reply({ employees: [] })
    expect(await client.recipients()).toMatchObject({
      ok: true,
      data: { employees: [], peopleSource: 'employees' }
    })
  })

  it('sends exact versions with the same operation and no renderer identity fields', async () => {
    reply({ thread, entry: { id: 'hentry_one' } })
    reply({ thread, replayed: true })
    expect(await client.send(send)).toMatchObject({ ok: true, data: { thread_id: thread.id } })
    expect(await client.send(send)).toMatchObject({ ok: true, data: { replayed: true } })
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      `https://console.test/api/gtd/hub/api/team/tasks/${thread.board_task_id}/handoffs`
    )
    expect(options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      method: 'POST',
      headers: { Authorization: 'Bearer test-person-only' }
    })
    expect(JSON.parse(options!.body as string)).toEqual({
      recipient_employee_id: 'emp_two',
      kind: 'handoff',
      title: thread.title,
      body: send.note,
      action: 'review',
      files: ['uploads/report.docx'],
      file_versions: send.fileVersions,
      idempotency_key: send.operationId
    })
    expect(fetchMock.mock.calls[1]![1]!.body).toBe(options!.body)
    expect(await client.send({ ...send, author_employee_id: 'emp_other' } as never)).toMatchObject({
      ok: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('uses attention without an open-state filter and marks only the handoff read', async () => {
    reply({ assignee: 'emp_two', threads: [] })
    await client.list()
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://console.test/api/gtd/hub/api/handoffs?view=attention'
    )
    reply({ thread, entries: [], files: [], reviews: [], read: true })
    expect((await client.markRead({ threadId: thread.id })).ok).toBe(true)
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `https://console.test/api/gtd/hub/api/handoffs/${thread.id}/read`
    )
    expect(fetchMock.mock.calls[1]![1]!.body).toBe('{}')
  })
  it('replies on a thread through the entries route the hub appends to', async () => {
    reply({ thread, entries: [], files: [], reviews: [] })
    expect(
      (
        await client.respond({
          threadId: thread.id,
          kind: 'reply',
          note: 'Answered in the session.',
          operationId: 'op-reply-1'
        })
      ).ok
    ).toBe(true)
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      `https://console.test/api/gtd/hub/api/handoffs/${thread.id}/entries`
    )
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toMatchObject({
      kind: 'reply',
      body: 'Answered in the session.'
    })
  })
  it('retains uncertainty and rejects a response after the signed person changes', async () => {
    reply({ error: 'Checking delivery', code: 'checking_delivery' }, 409)
    expect(await client.send(send)).toMatchObject({
      ok: false,
      error: { status: 409, code: 'checking_delivery' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    reply({ thread })
    current.mockReturnValueOnce(true).mockReturnValue(false)
    expect(await client.send(send)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })
  it('returns original bytes and rejects tampered metadata before HTTP', async () => {
    const file = capturedHandoffFile('report.docx', Buffer.from([0x50, 0x4b, 0, 255, 254]))
    reply({ thread })
    expect(
      (
        await client.returnFile({
          threadId: thread.id,
          baseVersionId: 'hfv_original',
          file,
          note: 'Revised',
          operationId: 'return_12345678'
        })
      ).ok
    ).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      content_base64: file.contentBase64,
      base_version_id: 'hfv_original'
    })
    expect(
      await client.returnFile({
        threadId: thread.id,
        baseVersionId: 'hfv_original',
        file: { ...file, sha256: digest },
        note: 'Revised',
        operationId: 'return_87654321'
      })
    ).toMatchObject({ ok: false, error: { code: 'file_changed' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('uses the returned upload path and verifies downloads against immutable version hashes', async () => {
    const bytes = Buffer.from([0, 255, 1, 254])
    const file = capturedHandoffFile('report.pdf', bytes)
    reply({
      files: [{ rel: 'uploads/report-2.pdf', sha256: file.sha256, size_bytes: bytes.length }]
    })
    expect(await uploadHandoffFile({ taskId: send.taskId, file })).toEqual({
      ok: true,
      data: { path: 'uploads/report-2.pdf', sha256: file.sha256 }
    })
    const version = {
      id: 'hfv_original',
      name: file.name,
      path: 'uploads/report-2.pdf',
      size: bytes.length,
      sha256: file.sha256,
      version: 1,
      parent_version_id: null,
      current: true,
      available: true
    }
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await downloadHandoffFile({ threadId: thread.id, file: version })).toEqual({
      ok: true,
      data: file
    })
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from('wrong')))
    expect(await downloadHandoffFile({ threadId: thread.id, file: version })).toMatchObject({
      ok: false,
      error: { code: 'file_changed' }
    })
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})

it.each(['ownership-transfer', 'feedback'] as const)(
  'carries %s as a pointer in the hub entry references list',
  async (disposition) => {
    reply({ thread })
    expect(await client.send({ ...send, disposition })).toMatchObject({ ok: true })
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      references: [{ kind: 'disposition', ref: disposition }]
    })
    reply({ thread: { ...thread, board_task_id: null } })
    expect(
      await client.sendCardless({
        recipient: send.recipient,
        title: send.title,
        note: send.note,
        operationId: send.operationId,
        disposition,
        attachments: []
      })
    ).toMatchObject({ ok: true })
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toMatchObject({
      references: [{ kind: 'disposition', ref: disposition }]
    })
  }
)
