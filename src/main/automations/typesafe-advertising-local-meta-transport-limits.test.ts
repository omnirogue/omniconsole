import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalMetaReader,
  type LocalMetaReaderIdentity
} from './typesafe-advertising-local-meta-transport'

const TOKEN = 'private-meta-token'
const ERROR = 'Local Meta evidence is unavailable.'
const BODY_BYTES = 1024 * 1024

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function reader(fetcher: typeof globalThis.fetch, identity: Partial<LocalMetaReaderIdentity> = {}) {
  return createLocalMetaReader(
    { token: TOKEN, isCurrent: () => true, ...identity },
    { fetch: fetcher }
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('local Meta collection timestamps', () => {
  it('uses local completion time even when the HTTP Date header is arbitrarily old', async () => {
    let now = Date.parse('2026-09-20T12:00:00Z')
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      now += 1_000
      return new Response('{"id":"12345"}', {
        headers: { Date: 'Mon, 01 Jan 2001 00:00:00 GMT' }
      })
    })
    const client = createLocalMetaReader(
      { token: TOKEN, isCurrent: () => true },
      { fetch: fetcher, now: () => now }
    )
    expect(await client.get('12345', {})).toEqual({
      value: { id: '12345' },
      collectedAt: '2026-09-20T12:00:01.000Z'
    })
  })

  it('retains the first completed GET collection time across multiple pages', async () => {
    let now = Date.parse('2026-09-20T12:00:00Z')
    let count = 0
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      now += 1_000
      count += 1
      return new Response(
        JSON.stringify({
          data: [{ spend: String(count) }],
          ...(count === 1
            ? {
                paging: {
                  cursors: { after: 'second-page' },
                  next: 'https://graph.facebook.com/v21.0/12345/insights?after=second-page'
                }
              }
            : {})
        })
      )
    })
    const client = createLocalMetaReader(
      { token: TOKEN, isCurrent: () => true },
      { fetch: fetcher, now: () => now }
    )
    expect(await client.list('12345/insights', {})).toEqual({
      rows: [{ spend: '1' }, { spend: '2' }],
      collectedAt: '2026-09-20T12:00:01.000Z'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('local Meta identity and resource limits', () => {
  it('rejects identity loss before network activity', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(reader(fetcher, { isCurrent: () => false }).get('12345', {})).rejects.toThrow(
      ERROR
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects identity loss after headers and cancels the unread response', async () => {
    let current = true
    const response = json({ id: '12345' })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      current = false
      return response
    })
    await expect(reader(fetcher, { isCurrent: () => current }).get('12345', {})).rejects.toThrow(
      ERROR
    )
    expect(response.bodyUsed).toBe(true)
  })

  it.each([1, 2, 3])(
    'rechecks private authority before network, after headers and after body (%s)',
    async (stage) => {
      const assertCurrent = vi.fn<() => Promise<void>>()
      for (let call = 1; call < stage; call += 1) {
        assertCurrent.mockResolvedValueOnce(undefined)
      }
      assertCurrent.mockRejectedValue(new Error(TOKEN))
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ id: '12345' }))
      await expect(reader(fetcher, { assertCurrent }).get('12345', {})).rejects.toThrow(
        new Error(ERROR)
      )
      expect(fetcher).toHaveBeenCalledTimes(stage === 1 ? 0 : 1)
      expect(assertCurrent).toHaveBeenCalledTimes(stage)
    }
  )

  it('caps response bytes even without content length and rejects overly nested JSON', async () => {
    for (const response of [
      json({ value: 'é'.repeat(BODY_BYTES / 2) }),
      new Response(`{"value":${'['.repeat(33)}0${']'.repeat(33)}}`),
      new Response(new Uint8Array([0xff, 0xfe]))
    ]) {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      await expect(reader(fetcher).get('12345', {})).rejects.toThrow(ERROR)
    }
  })

  it('enforces the total 16 MiB budget across requests', async () => {
    const content = JSON.stringify({
      padding: 'x'.repeat(BODY_BYTES - JSON.stringify({ padding: '' }).length)
    })
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(content))
    const client = reader(fetcher)
    for (let count = 0; count < 16; count += 1) {
      await client.get('12345', {})
    }
    await expect(client.get('12345', {})).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(16)
  })

  it('cancels a response with an oversized declared body before reading it', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'content-length': String(BODY_BYTES + 1) }
    })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    await expect(reader(fetcher).get('12345', {})).rejects.toThrow(ERROR)
    expect(cancelled).toHaveBeenCalled()
  })

  it('enforces 160 total requests even with concurrent callers', async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ id: '12345' }))
    const client = reader(fetcher)
    const results = await Promise.allSettled(
      Array.from({ length: 161 }, () => client.get('12345', {}))
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(160)
    expect(results[160].status).toBe('rejected')
    expect(fetcher).toHaveBeenCalledTimes(160)
  })

  it('stops after the whole-reader deadline without a new request', async () => {
    let now = 0
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ id: '12345' }))
    const client = createLocalMetaReader(
      { token: TOKEN, isCurrent: () => true },
      { fetch: fetcher, now: () => now }
    )
    await client.get('12345', {})
    now = 90_000
    await expect(client.get('12345', {})).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('times out a stalled fetch and aborts without retrying', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}))
    const result = expect(reader(fetcher).get('12345', {})).rejects.toThrow(ERROR)
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('shortens the final request timeout to the remaining whole-reader deadline', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}))
    const client = reader(fetcher)
    await vi.advanceTimersByTimeAsync(89_000)
    const result = expect(client.get('12345', {})).rejects.toThrow(ERROR)
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('keeps the timeout active while a response body stalls', async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new ReadableStream()))
    const result = expect(reader(fetcher).get('12345', {})).rejects.toThrow(ERROR)
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('includes asynchronous authority checks inside the request deadline', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof globalThis.fetch>()
    let resolveAuthority = (): void => {}
    const authority = new Promise<void>((resolve) => {
      resolveAuthority = resolve
    })
    const result = expect(
      reader(fetcher, { assertCurrent: () => authority }).get('12345', {})
    ).rejects.toThrow(ERROR)
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    resolveAuthority()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
