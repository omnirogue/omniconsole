import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { consoleHandoffClient as client } from './console-handoff-client'
import { cardlessHandoffsRefusal } from './console-handoff-cardless-gate'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow } from './console-workflow-transport'
import {
  handoffBind,
  handoffQueue,
  handoffSendCardless,
  handoffThread
} from '../../shared/console-handoff-contract'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const bytes = Buffer.from('a note-only handoff attachment')
const file = {
  name: 'brief.md',
  contentBase64: bytes.toString('base64'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length
}
const cardless = {
  id: 'hth_free',
  board_task_id: null,
  author_employee_id: 'emp_one',
  recipient_employee_id: 'emp_two',
  title: 'Look at this file',
  state: 'open',
  action: null,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-11T21:00:00Z'
}
const sendInput = {
  title: cardless.title,
  recipient: 'emp_two',
  note: 'Here is the file.',
  operationId: 'ns_cardless_0001',
  attachments: [file]
}
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function lastRequest(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1)!
  return { url: String(url), body: JSON.parse(String(init?.body)) }
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

describe('card-less handoff contract', () => {
  it('reads a thread that belongs to no card', () => {
    expect(handoffThread.safeParse(cardless).success).toBe(true)
    expect(handoffQueue.safeParse({ assignee: 'emp_two', threads: [cardless] }).success).toBe(true)
  })

  it('refuses a card on a card-less send and a malformed card on a bind', () => {
    expect(handoffSendCardless.safeParse(sendInput).success).toBe(true)
    expect(handoffSendCardless.safeParse({ ...sendInput, taskId: 'btk_abcd' }).success).toBe(false)
    expect(handoffBind.safeParse({ threadId: 'hth_free', taskId: 'btk_abcd' }).success).toBe(true)
    expect(handoffBind.safeParse({ threadId: 'hth_free', taskId: 'dcn_abcd' }).success).toBe(false)
  })
})

describe('card-less handoff client', () => {
  it('sends a thread with its attachments to the hub route that needs no card', async () => {
    reply({ thread: cardless, entry: { id: 'hentry_free' } })
    expect(await client.sendCardless(sendInput)).toMatchObject({
      ok: true,
      data: { thread_id: 'hth_free', entry_id: 'hentry_free' }
    })
    const { url, body } = lastRequest()
    expect(url).toBe('https://console.test/api/gtd/hub/api/handoffs')
    expect(body).toEqual({
      recipient_employee_id: 'emp_two',
      kind: 'handoff',
      title: cardless.title,
      body: 'Here is the file.',
      idempotency_key: 'ns_cardless_0001',
      attachments: [{ filename: 'brief.md', content_base64: file.contentBase64 }]
    })
  })

  it('refuses attachment bytes that no longer hash to their version before any request', async () => {
    const result = await client.sendCardless({
      ...sendInput,
      attachments: [{ ...file, sha256: 'b'.repeat(64) }]
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'file_changed' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adds a file to an open thread as an exact version', async () => {
    reply({ thread: cardless, entry: { id: 'hentry_upload' } })
    const result = await client.uploadThreadFile({
      threadId: 'hth_free',
      file,
      note: 'Forgot this one.',
      operationId: 'ns_upload_00001'
    })
    expect(result).toMatchObject({ ok: true, data: { entry_id: 'hentry_upload' } })
    const { url, body } = lastRequest()
    expect(url).toBe('https://console.test/api/gtd/hub/api/handoffs/hth_free/files/upload')
    expect(body).toEqual({
      filename: 'brief.md',
      content_base64: file.contentBase64,
      note: 'Forgot this one.',
      idempotency_key: 'ns_upload_00001'
    })
  })

  it('binds a thread to a card and refuses a receipt that shows another card', async () => {
    reply({ thread: { ...cardless, board_task_id: 'btk_abcd' }, entry: { id: 'hentry_bind' } })
    expect(await client.bindThread({ threadId: 'hth_free', taskId: 'btk_abcd' })).toMatchObject({
      ok: true,
      data: { thread_id: 'hth_free' }
    })
    expect(lastRequest()).toEqual({
      url: 'https://console.test/api/gtd/hub/api/handoffs/hth_free/bind',
      body: { board_task_id: 'btk_abcd' }
    })
    reply({ thread: { ...cardless, board_task_id: 'btk_other' }, entry: { id: 'hentry_bind' } })
    expect(await client.bindThread({ threadId: 'hth_free', taskId: 'btk_abcd' })).toMatchObject({
      ok: false
    })
  })

  it('refuses a card send whose receipt names no card', async () => {
    reply({ thread: cardless, entry: { id: 'hentry_one' } })
    const result = await client.send({
      taskId: 'btk_abcd',
      title: 'Review',
      recipient: 'emp_two',
      note: 'Please review.',
      fileVersions: [],
      operationId: 'request_12345678'
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
  })
})

describe('card-less handoff transport shapes', () => {
  it.each([
    '/api/gtd/hub/api/handoffs',
    '/api/gtd/hub/api/handoffs/hth_free/files/upload',
    '/api/gtd/hub/api/handoffs/hth_free/bind'
  ])('carries POST %s', async (path) => {
    reply({ ok: true })
    expect(
      await requestConsoleWorkflow(path, 'POST', handoffQueue.partial().passthrough(), {})
    ).toMatchObject({ ok: true })
  })

  it.each([
    ['GET', '/api/gtd/hub/api/handoffs?assignee=emp_two'],
    ['POST', '/api/gtd/hub/api/handoffs/hth_free/files/other'],
    ['POST', '/api/gtd/hub/api/handoffs/hth_free/bind/extra'],
    ['PATCH', '/api/gtd/hub/api/handoffs/hth_free/bind']
  ] as const)('still refuses %s %s before any request', async (method, path) => {
    expect(await requestConsoleWorkflow(path, method, handoffQueue, {})).toMatchObject({
      ok: false
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('card-less handoff gate', () => {
  it.each([
    undefined,
    null,
    {},
    { experimentalCardlessHandoffs: true },
    { experimentalCardlessHandoffs: false }
  ])('allows the production default even with an explicit opt-out: %j', (settings) => {
    expect(cardlessHandoffsRefusal(settings)).toBeNull()
  })
})
