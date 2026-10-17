import { beforeEach, expect, it, vi } from 'vitest'
import { consoleRoutineConversationClient as client } from './console-routine-conversation-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person',
      baseUrl: 'https://console.test',
      principal: 'person',
      isCurrent: () => true
    }
  } as never)
})

it.each([
  ['getConversation', '/api/work/card/btk_demo/conversation', 'GET', { ok: true, messages: [] }],
  [
    'postMessage',
    '/api/board/btk_demo/message',
    'POST',
    {
      ok: true,
      status: 200,
      payload: { id: 'cnv_1', delivered_live: true, queued_for_next_attempt: false }
    }
  ]
] as const)('calls %s at exactly %s using %s', async (operation, path, method, response) => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)))
  const result =
    operation === 'postMessage'
      ? await client.postMessage({ taskId: 'btk_demo', content: 'Hello' })
      : await client.getConversation({ taskId: 'btk_demo' })
  expect(result).toEqual({ ok: true, data: response })
  expect(fetchMock).toHaveBeenCalledWith(
    `https://console.test${path}`,
    expect.objectContaining({
      method,
      ...(method === 'POST' ? { body: JSON.stringify({ content: 'Hello' }) } : {})
    })
  )
})
it.each(['btk_', 'btk_abc', 'btk_ab_cd', 'btk_demo/evil', 'btk_demo?x=1', `btk_${'a'.repeat(65)}`])(
  'refuses invalid card ID %s before transport',
  async (taskId) => {
    expect(await client.getConversation({ taskId })).toMatchObject({ ok: false })
    expect(await client.postMessage({ taskId, content: 'Hello' })).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  }
)
it.each([403, 404])('preserves the server refusal on HTTP %s', async (status) => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        detail: { code: 'board_message_forbidden', message: 'Membership changed' }
      }),
      { status }
    )
  )
  expect(await client.postMessage({ taskId: 'btk_demo', content: 'Hello' })).toMatchObject({
    ok: false,
    error: { status, code: 'board_message_forbidden', message: 'Membership changed' }
  })
})
it('preserves a cached-read refusal reason', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: false, reason: 'Card is private' }))
  )
  expect(await client.getConversation({ taskId: 'btk_demo' })).toMatchObject({
    ok: false,
    error: { message: 'Card is private' }
  })
})
