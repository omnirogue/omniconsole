import { afterEach, describe, expect, it, vi } from 'vitest'
import { metaTarget } from './local-meta-fixtures'
import { createLocalMetaStatusWriter } from './local-meta-status-transport'

const ERROR = 'Local Meta status change is unverified.'
const BODY_BYTES = 64 * 1024
type Identity = Parameters<typeof createLocalMetaStatusWriter>[0]

function accepted(): Response {
  return new Response('{"success":true}')
}

function writer(fetcher: typeof globalThis.fetch, identity: Partial<Identity> = {}) {
  return createLocalMetaStatusWriter(
    {
      token: 'private-test-meta-token',
      isCurrent: () => true,
      assertCurrent: async () => {},
      ...identity
    },
    { fetch: fetcher }
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('local Meta status authority fences', () => {
  it('rejects revoked identity before any request', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(
      writer(fetcher, { isCurrent: () => false }).send(metaTarget(), 'PAUSED')
    ).rejects.toThrow(new Error(ERROR))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])(
    'checks authority before fetch, after headers and after body (%s)',
    async (stage) => {
      const assertCurrent = vi.fn<() => Promise<void>>()
      for (let call = 1; call < stage; call += 1) {
        assertCurrent.mockResolvedValueOnce(undefined)
      }
      assertCurrent.mockRejectedValue(new Error('private authority detail'))
      const response = accepted()
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      await expect(writer(fetcher, { assertCurrent }).send(metaTarget(), 'PAUSED')).rejects.toThrow(
        new Error(ERROR)
      )
      expect(assertCurrent).toHaveBeenCalledTimes(stage)
      expect(fetcher).toHaveBeenCalledTimes(stage === 1 ? 0 : 1)
      if (stage > 1) {
        expect(response.bodyUsed).toBe(true)
      }
    }
  )

  it('rechecks synchronous identity at fetch admission after an asynchronous authority fence', async () => {
    let current = true
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted())
    const assertCurrent = async (): Promise<void> => {
      queueMicrotask(() => {
        current = false
      })
    }
    await expect(
      writer(fetcher, { isCurrent: () => current, assertCurrent }).send(metaTarget(), 'PAUSED')
    ).rejects.toThrow(new Error(ERROR))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects identity revoked as response headers arrive and cancels the unread body', async () => {
    let current = true
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      current = false
      return response
    })
    await expect(
      writer(fetcher, { isCurrent: () => current }).send(metaTarget(), 'ACTIVE')
    ).rejects.toThrow(new Error(ERROR))
    expect(cancelled).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects revocation during body collection despite an accepted provider response', async () => {
    let current = true
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            current = false
            controller.enqueue(new TextEncoder().encode('{"success":true}'))
            controller.close()
          }
        },
        { highWaterMark: 0 }
      )
    )
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    await expect(
      writer(fetcher, { isCurrent: () => current }).send(metaTarget(), 'ACTIVE')
    ).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('local Meta status total deadline', () => {
  it.each([1, 2, 3])(
    'bounds a stalled authority check at stage %s and fences its late resolution',
    async (stage) => {
      vi.useFakeTimers()
      const gate = deferred<void>()
      const assertCurrent = vi.fn<() => Promise<void>>()
      for (let call = 1; call < stage; call += 1) {
        assertCurrent.mockResolvedValueOnce(undefined)
      }
      assertCurrent.mockReturnValue(gate.promise)
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted())
      const client = writer(fetcher, { assertCurrent })
      const fulfilled = vi.fn()
      const result = expect(client.send(metaTarget(), 'PAUSED').then(fulfilled)).rejects.toThrow(
        new Error(ERROR)
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await result
      gate.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(stage === 1 ? 0 : 1)
      expect(fulfilled).not.toHaveBeenCalled()
      await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      expect(fetcher).toHaveBeenCalledTimes(stage === 1 ? 0 : 1)
    }
  )

  it('aborts one stalled fetch, cancels a late response and never retries', async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending.promise)
    const client = writer(fetcher)
    const fulfilled = vi.fn()
    const result = expect(client.send(metaTarget(), 'ACTIVE').then(fulfilled)).rejects.toThrow(
      new Error(ERROR)
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const cancelled = vi.fn()
    pending.resolve(new Response(new ReadableStream({ cancel: cancelled })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(fulfilled).not.toHaveBeenCalled()
    await expect(client.send(metaTarget(), 'ACTIVE')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps one 10-second deadline across authority, headers and a stalled body', async () => {
    vi.useFakeTimers()
    const assertCurrent = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 4_000)))
      .mockResolvedValue(undefined)
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>()
    const cancelled = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({ start: body.resolve, cancel: cancelled })
    )
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(response), 4_000))
      )
    const fulfilled = vi.fn()
    const rejected = vi.fn()
    const result = writer(fetcher, { assertCurrent })
      .send(metaTarget(), 'PAUSED')
      .then(fulfilled, rejected)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(rejected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(rejected).toHaveBeenCalledWith(new Error(ERROR))
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const controller = await body.promise
    if (cancelled.mock.calls.length === 0) {
      controller.enqueue(new TextEncoder().encode('{"success":true}'))
      controller.close()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(fulfilled).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('starts the deadline at send, not writer construction', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted())
    const client = writer(fetcher)
    await vi.advanceTimersByTimeAsync(60_000)
    await client.send(metaTarget(), 'ACTIVE')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('refuses a response after the injected clock reaches the deadline', async () => {
    let now = 0
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      now = 10_000
      return accepted()
    })
    const client = createLocalMetaStatusWriter(
      { token: 'private-test-meta-token', isCurrent: () => true, assertCurrent: async () => {} },
      { fetch: fetcher, now: () => now }
    )
    await expect(client.send(metaTarget(), 'ACTIVE')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('local Meta status response limits', () => {
  it.each([
    ['body bytes', () => new Response(`{"success":true${' '.repeat(BODY_BYTES)}}`)],
    [
      'UTF-8 bytes rather than characters',
      () => new Response(`{"success":true,"padding":"${'é'.repeat(BODY_BYTES / 2)}"}`)
    ],
    ['nesting depth', () => new Response('{"success":true,"extra":[[[[0]]]]}')],
    [
      'structural tokens',
      () => new Response(`{${Array.from({ length: 8 }, () => '"success":true').join(',')}}`)
    ],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff, 0xfe]))]
  ] as const)('rejects %s without exposing parser details', async (_name, response) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response())
    await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('cancels an oversized declared body before waiting for any bytes', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'content-length': String(BODY_BYTES + 1) }
    })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('accepts a success response exactly at the byte boundary', async () => {
    const text = '{"success":true}'
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(text + ' '.repeat(BODY_BYTES - text.length)))
    await writer(fetcher).send(metaTarget(), 'PAUSED')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
