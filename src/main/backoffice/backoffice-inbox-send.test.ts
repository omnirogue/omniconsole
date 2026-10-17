import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sendInboxMessage } from './backoffice-inbox-send'

const fixture = vi.hoisted(() => ({ current: true, principal: 'person_a' }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      baseUrl: 'https://fixture.test',
      bearer: 'fixture-only',
      principal: fixture.principal,
      isCurrent: () => fixture.current
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetcher = vi.fn()
const post = vi.fn()
const input = {
  to: 'emp_other',
  text: 'Please review.',
  purpose: 'question' as const,
  idempotencyKey: 'fixture-send-1'
}
const identity = { ok: true, user: { employee_id: 'emp_sender' } }
function receipt() {
  return {
    recipient: {
      session_id: 'pc_human',
      employee_id: 'emp_other',
      endpoint_kind: 'logical_app',
      inbox_ready: true
    },
    message: {
      id: `pm_${'a'.repeat(24)}`,
      recipient_session_id: 'pc_human',
      recipient_employee_id: 'emp_other',
      sender_employee_id: 'emp_sender',
      summary: input.text,
      purpose: input.purpose,
      references: [] as string[],
      state: 'queued'
    }
  }
}
beforeEach(() => {
  fixture.current = true
  fixture.principal = 'person_a'
  fetcher.mockReset()
  post.mockReset().mockImplementation(async () => Response.json(receipt()))
  fetcher.mockImplementation(async (url: string) =>
    url.endsWith('/api/me') ? Response.json(identity) : post()
  )
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => vi.unstubAllGlobals())
const sends = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/api/peer/send'))

it('uses the shared captured-person transport for identity and the exact human send receipt', async () => {
  expect(await sendInboxMessage(input)).toMatchObject({
    ok: true,
    body: { message: { id: `pm_${'a'.repeat(24)}`, recipient_employee_id: 'emp_other' } }
  })
  await sendInboxMessage(input)
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://fixture.test/api/me',
    'https://fixture.test/api/peer/send',
    'https://fixture.test/api/me',
    'https://fixture.test/api/peer/send'
  ])
  for (const [, request] of fetcher.mock.calls) {
    expect(request.headers.Authorization).toBe('Bearer fixture-only')
    expect(request.redirect).toBe('error')
    expect(request.credentials).toBe('omit')
  }
  for (const [, request] of sends()) {
    expect(request.headers['Idempotency-Key']).toBe(input.idempotencyKey)
    expect(JSON.parse(request.body)).toEqual({
      to: input.to,
      text: input.text,
      purpose: input.purpose,
      references: [],
      idempotency_key: input.idempotencyKey
    })
  }
})

it.each(['queued', 'delivered', 'replied', 'resolved', 'expired'])(
  'accepts a verified retry receipt that has advanced to %s',
  async (state) => {
    const body = receipt()
    body.message.state = state
    post.mockResolvedValue(Response.json(body))
    expect((await sendInboxMessage(input)).ok).toBe(true)
  }
)

it('accepts an older verified BFF receipt without the optional inbox_ready hint', async () => {
  const body = receipt()
  post.mockResolvedValue(
    Response.json({ ...body, recipient: { ...body.recipient, inbox_ready: undefined } })
  )
  expect((await sendInboxMessage(input)).ok).toBe(true)
})

it.each([
  ['missing recipient', { recipient: undefined }],
  ['wrong selected employee', { recipient: { employee_id: 'emp_wrong' } }],
  ['runtime instead of human Inbox', { recipient: { endpoint_kind: 'runtime' } }],
  ['unready Inbox', { recipient: { inbox_ready: false } }],
  ['wrong recipient session', { message: { recipient_session_id: 'pc_other' } }],
  ['wrong message employee', { message: { recipient_employee_id: 'emp_wrong' } }],
  ['wrong sender employee', { message: { sender_employee_id: 'emp_wrong' } }],
  ['wrong message id', { message: { id: 'pm_abcd1234' } }],
  ['invalid state', { message: { state: 'sent' } }],
  ['different message', { message: { summary: 'Different content' } }],
  ['different purpose', { message: { purpose: 'status' } }],
  ['different references', { message: { references: ['https://example.com/other'] } }]
])('does not confirm a %s receipt', async (_name, patch) => {
  const body = receipt()
  post.mockResolvedValue(
    Response.json({
      ...body,
      ...('recipient' in patch
        ? { recipient: patch.recipient ? { ...body.recipient, ...patch.recipient } : undefined }
        : {}),
      ...('message' in patch ? { message: { ...body.message, ...patch.message } } : {})
    })
  )
  expect(await sendInboxMessage(input)).toMatchObject({
    ok: false,
    code: 'invalid_response',
    message: expect.stringContaining('receipt could not be verified')
  })
})

it('preserves the full permitted message and every explicit reference', async () => {
  const text = 'A'.repeat(2048)
  const references = ['https://example.com/plan', 'https://example.com/results']
  const body = receipt()
  body.message.summary = text
  body.message.references = references
  post.mockResolvedValue(Response.json(body))
  expect((await sendInboxMessage({ ...input, text, references })).ok).toBe(true)
  expect(JSON.parse(sends()[0]![1].body)).toMatchObject({ text, references })
})

it.each([
  { to: 'pc_human' },
  { to: 'ses_agent' },
  { text: '' },
  { text: '😀'.repeat(513) },
  { references: ['ftp://example.com/file'] },
  { references: Array(5).fill('https://example.com') },
  { references: [`https://example.com/${'x'.repeat(512)}`] },
  { idempotencyKey: '../bad' }
])('refuses invalid person/message input without sending: %j', async (patch) => {
  expect(await sendInboxMessage({ ...input, ...patch })).toMatchObject({
    ok: false,
    code: 'invalid_request'
  })
  expect(fetcher).not.toHaveBeenCalled()
})

it('stops if the account changes during the identity read', async () => {
  fetcher.mockImplementation(async () => {
    fixture.current = false
    return Response.json(identity)
  })
  expect(await sendInboxMessage(input)).toMatchObject({ ok: false, code: 'connection_changed' })
  expect(sends()).toHaveLength(0)
})

it('rejects a changed captured principal between the identity read and POST', async () => {
  fetcher.mockImplementation(async () => {
    fixture.principal = 'person_b'
    return Response.json(identity)
  })
  expect(await sendInboxMessage(input)).toMatchObject({ ok: false, code: 'principal_mismatch' })
  expect(sends()).toHaveLength(0)
})

it('does not report delivery after the account changes during POST', async () => {
  post.mockImplementation(async () => {
    fixture.current = false
    return Response.json(receipt())
  })
  expect(await sendInboxMessage(input)).toMatchObject({ ok: false, code: 'connection_changed' })
})

it('refuses an unverified sender employee before sending', async () => {
  fetcher.mockResolvedValue(Response.json({ ok: true, user: { employee_id: null } }))
  expect(await sendInboxMessage(input)).toMatchObject({
    ok: false,
    message: expect.stringContaining('employee profile')
  })
  expect(sends()).toHaveLength(0)
})

it('relays a server refusal without claiming delivery', async () => {
  post.mockResolvedValue(
    Response.json(
      {
        error: {
          code: 'peer_scope_forbidden',
          message: 'Direct contact is limited to the exact project'
        }
      },
      { status: 403 }
    )
  )
  expect(await sendInboxMessage(input)).toEqual({
    ok: false,
    code: 'peer_scope_forbidden',
    message: 'Direct contact is limited to the exact project'
  })
})

it.each([200, 401, 403, 500])('consumes malformed JSON before refusing HTTP %s', async (status) => {
  const response = new Response('not JSON', { status })
  post.mockResolvedValue(response)
  expect(await sendInboxMessage(input)).toMatchObject({ ok: false })
  expect(response.bodyUsed).toBe(true)
})

it('cancels an oversized receipt through the shared bounded transport', async () => {
  const cancel = vi.fn()
  post.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Length': String(17 * 1024 * 1024) }
    })
  )
  expect(await sendInboxMessage(input)).toMatchObject({ ok: false })
  expect(cancel).toHaveBeenCalledOnce()
})
