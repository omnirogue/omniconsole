import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomClient } from './room-client'
import { RoomError } from './room-error'
import { ID, USER, TOKEN, json, detail, roomEvent } from '../../shared/room-test-fixtures'

afterEach(() => vi.useRealTimers())
const access = () => ({
  token: TOKEN,
  apiOrigin: 'https://api.example.com',
  check: () => undefined
})
const body = { eventId: ID, content: 'Hello', mentionedUserIds: [USER], targetAgentIds: [ID] }
describe('RoomClient native transport', () => {
  it('omits Origin and Cookie, sends the exact event id on byte-identical replays', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ sequence: '3', replayed: true }))
    const client = new RoomClient(access, fetcher)
    await client.send(ID, body)
    await client.send(ID, body)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(`https://api.example.com/api/omniconsole/rooms/${ID}/messages`)
    const headers = new Headers(init?.headers)
    expect(headers.get('Origin')).toBeNull()
    expect(headers.get('Cookie')).toBeNull()
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('Idempotency-Key')).toBe(ID)
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
    expect(JSON.parse(init?.body as string)).toEqual(body)
    expect(fetcher.mock.calls[1][1]?.body).toBe(init?.body)
  })
  it.each([true, false])(
    'enforces the 2 MiB response cap (content-length: %s)',
    async (declared) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('x'.repeat(2 * 1024 * 1024 + 1), {
          headers: {
            'content-type': 'application/json',
            ...(declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {})
          }
        })
      )
      await expect(new RoomClient(access, fetcher).listRooms()).rejects.toMatchObject({
        code: 'response_too_large'
      })
    }
  )
  it.each([
    [401, 'unauthorized', 'device_unauthorized'],
    [403, 'native_source_required', 'forbidden'],
    [409, 'idempotency_conflict', 'idempotency_conflict'],
    [409, 'new_server_code', 'conflict'],
    [429, 'too_many', 'rate_limited'],
    [503, 'room_busy', 'rooms_unavailable']
  ])('maps HTTP %s and %s into %s', async (status, code, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: code, message: TOKEN }, Number(status)))
    // A credential echo is rejected before any server text could reach IPC.
    await expect(new RoomClient(access, fetcher).listRooms()).rejects.toMatchObject({
      code: 'invalid_response'
    })
    fetcher.mockResolvedValue(
      json({ error: code, message: 'untrusted server message' }, Number(status))
    )
    await expect(new RoomClient(access, fetcher).listRooms()).rejects.toMatchObject({
      code: expected,
      message: expected
    })
  })
  it('times out a hung fetch at 15 seconds without retrying', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined))
    const result = new RoomClient(access, fetcher).listRooms()
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(15000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('checks the same credential lease after a response', async () => {
    const check = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new RoomError('connection_changed')
      })
    const client = new RoomClient(
      () => ({ ...access(), check }),
      vi.fn<typeof fetch>().mockResolvedValue(json({ rooms: [], nextCursor: null }))
    )
    await expect(client.listRooms()).rejects.toMatchObject({ code: 'connection_changed' })
  })
  it('validates paths and strict send bodies before a network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new RoomClient(access, fetcher)
    expect(() => client.getRoom('../device/token')).toThrow()
    expect(() => client.events(ID, '-1')).toThrow()
    expect(() => client.send(ID, { ...body, content: 'x'.repeat(3001) })).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('implements the exact list, detail, events, summary, ack and native ticket routes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ rooms: [], nextCursor: null }))
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(json({ events: [roomEvent()], nextCursor: '1' }))
      .mockResolvedValueOnce(json({ rooms: [], agents: [], nextCursor: null }))
      .mockResolvedValueOnce(
        json({ roomId: ID, recipientId: USER, consumedSequence: '1', replayed: false })
      )
      .mockResolvedValueOnce(
        json({
          ticket: 't'.repeat(43),
          url: 'wss://api.example.com/ws/rooms',
          expiresAt: 1800000000000
        })
      )
    const client = new RoomClient(access, fetcher)
    await client.listRooms('a/b+')
    await client.getRoom(ID)
    await client.events(ID, 'latest')
    await client.pendingSummary(ID)
    await client.ack(ID, '1')
    await client.connectionTicket()
    expect(
      fetcher.mock.calls.map(([url]) =>
        String(url).replace('https://api.example.com/api/omniconsole/rooms', '')
      )
    ).toEqual([
      '?after=a%2Fb%2B',
      `/${ID}`,
      `/${ID}/events?after=latest`,
      `/pending_summary?after=${ID}`,
      `/${ID}/ack`,
      '/connection'
    ])
  })
})
