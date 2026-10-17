import { beforeEach, expect, it, vi } from 'vitest'
import { consolePeerActions as client } from './console-peer-actions'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const send = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
beforeEach(() => {
  vi.resetAllMocks()
  current.mockReturnValue(true)
  vi.stubGlobal('fetch', send)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'isolated-person',
      baseUrl: 'https://console.test',
      principal: 'person_a',
      isCurrent: current
    }
  } as never)
})
const answer = (body: unknown, status = 200) =>
  send.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
const post = {
  id: 'post_a',
  room_id: 'room_a',
  sender_employee_id: 'emp_a',
  summary: 'hello',
  references: [],
  created_at: 1,
  deliveries: []
}

it('posts through the same peer route as the MCP with a retained operation ID and signed person', async () => {
  answer({ post })
  expect(
    (await client.postDiscussion({ roomId: 'room_a', text: 'hello', operationId: 'intent_a' })).ok
  ).toBe(true)
  const [url, init] = send.mock.calls[0]!
  expect(url).toBe('https://console.test/api/peer/rooms/room_a/messages')
  expect(init?.headers).toMatchObject({ Authorization: 'Bearer isolated-person' })
  expect(JSON.parse(init!.body as string)).toEqual({
    text: 'hello',
    references: [],
    idempotency_key: 'intent_a'
  })
})
it('validates join membership and binds replies to the original message', async () => {
  answer({
    room_id: 'room_a',
    membership: { id: 'member_a', room_id: 'room_a', employee_id: 'emp_a', session_id: 'pc_a' }
  })
  expect((await client.joinDiscussion({ roomId: 'room_a', operationId: 'join_a' })).ok).toBe(true)
  answer({ id: 'reply_a', reply_to: 'message_a', state: 'queued' })
  expect(
    (
      await client.replyPeerMessage({
        messageId: 'message_a',
        text: 'answer',
        operationId: 'reply_a'
      })
    ).ok
  ).toBe(true)
  expect(send.mock.calls[1]?.[0]).toBe('https://console.test/api/peer/reply')
  answer({ id: 'reply_a', reply_to: 'another_message', state: 'queued' })
  expect(
    await client.replyPeerMessage({
      messageId: 'message_a',
      text: 'answer',
      operationId: 'reply_a'
    })
  ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
})
it('refuses wrong-room receipts, forged identities, oversized UTF-8 and path injection', async () => {
  answer({ post: { ...post, room_id: 'room_b' } })
  expect(
    (await client.postDiscussion({ roomId: 'room_a', text: 'hello', operationId: 'intent_a' })).ok
  ).toBe(false)
  send.mockClear()
  for (const args of [
    { roomId: '../admin', text: 'hello', operationId: 'intent_a' },
    { roomId: 'room_a', text: '😀'.repeat(600), operationId: 'intent_a' },
    { roomId: 'room_a', text: 'hello', operationId: 'intent_a', employee_id: 'emp_other' }
  ]) {
    expect((await client.postDiscussion(args)).ok).toBe(false)
  }
  expect(send).not.toHaveBeenCalled()
})
it('does not report success after account switching or conceal a membership refusal', async () => {
  send.mockImplementationOnce(async () => {
    current.mockReturnValue(false)
    return new Response(JSON.stringify({ post }))
  })
  expect(
    await client.postDiscussion({ roomId: 'room_a', text: 'hello', operationId: 'intent_a' })
  ).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
  current.mockReturnValue(true)
  answer({ error: { code: 'room_not_joined', message: 'Join this room first' } }, 403)
  expect(
    await client.postDiscussion({ roomId: 'room_a', text: 'hello', operationId: 'intent_a' })
  ).toMatchObject({ ok: false })
})

it('reads the messaging authority without exposing identity configuration or enrolling an endpoint', async () => {
  answer({
    mode: 'omniconsole',
    ready: true,
    legacyWritesFenced: true,
    publishableKey: 'public-config',
    issuer: 'https://issuer.test'
  })
  expect(await client.readCommunicationMode()).toEqual({
    ok: true,
    data: { mode: 'omniconsole', ready: true, legacyWritesFenced: true }
  })
  expect(send.mock.calls[0]?.[0]).toBe('https://console.test/api/communication/config')
  expect(send.mock.calls[0]?.[1]?.method).toBe('GET')
  expect(send.mock.calls[0]?.[1]?.body).toBeUndefined()
  answer({ mode: 'omniconsole', ready: true, legacyWritesFenced: false })
  expect(await client.readCommunicationMode()).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})
