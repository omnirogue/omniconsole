import { afterEach, expect, it, vi } from 'vitest'
import { readBackofficeCached } from './backoffice-read-cache'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'
import { API_RESPONSE_MAX_BYTES } from '../../shared/fetch-response-body'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function unread304(cancel: () => void): Response {
  const response = cancelTrackingResponse(200, cancel)
  // Response's constructor forbids a 304 body; model the transport's unread body handle.
  Object.defineProperties(response, { status: { value: 304 }, ok: { value: false } })
  return response
}

it('cancels the single 304 network body once for all coalesced readers', async () => {
  const cancel = vi.fn()
  const unchanged = unread304(cancel)
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { headers: { etag: '"version"' } }))
    .mockResolvedValueOnce(unchanged)
  vi.stubGlobal('fetch', fetch)
  const first = await readBackofficeCached('https://body.test/conditional')
  const results = await Promise.all([
    readBackofficeCached('https://body.test/conditional'),
    readBackofficeCached('https://body.test/conditional')
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(cancel).toHaveBeenCalledTimes(1)
  for (const result of results) {
    expect(result.notModified).toBe(true)
    expect(result.body).toBe(first.body)
    expect(result.response).toBe(unchanged)
  }
  expect(await unchanged.body!.getReader().read()).toEqual({ done: true, value: undefined })
})

it('cancels an unexpected 304 without attempting to read its body', async () => {
  const cancel = vi.fn()
  const response = unread304(cancel)
  const getReader = vi.spyOn(response.body!, 'getReader').mockImplementation(() => {
    throw new Error('304 must not be read')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  const result = await readBackofficeCached('https://body.test/unexpected-304')
  expect(result.response.status).toBe(304)
  expect(result.notModified).toBeUndefined()
  expect(result.response.body).toBeNull()
  expect(getReader).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each([200, 502])('cancels a live body if reader setup throws on HTTP %s', async (status) => {
  const cancel = vi.fn()
  const response = cancelTrackingResponse(status, cancel)
  vi.spyOn(response.body!, 'getReader').mockImplementationOnce(() => {
    throw new Error('reader setup failed')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  await expect(readBackofficeCached(`https://body.test/setup-${status}`)).rejects.toThrow(
    'reader setup failed'
  )
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each([200, 502])('cancels a response rejected by the byte limit on HTTP %s', async (status) => {
  const cancel = vi.fn()
  const response = cancelTrackingResponse(status, cancel)
  response.headers.set('content-length', String(API_RESPONSE_MAX_BYTES + 1))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  await expect(readBackofficeCached(`https://body.test/limit-${status}`)).rejects.toThrow(
    'byte limit'
  )
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('cleans up after a reader aborts and releases its lock', async () => {
  const cancel = vi.fn()
  const response = cancelTrackingResponse(200, cancel)
  const reader = response.body!.getReader()
  vi.spyOn(reader, 'read').mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
  vi.spyOn(response.body!, 'getReader').mockReturnValueOnce(reader)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  await expect(readBackofficeCached('https://body.test/abort')).rejects.toThrow('aborted')
  expect(response.body!.locked).toBe(false)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each(['{malformed', `${'['.repeat(130)}0${']'.repeat(130)}`])(
  'consumes the body before a JSON/schema rejection: %s',
  async (body) => {
    const response = new Response(body)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    await expect(readBackofficeCached('https://body.test/malformed')).rejects.toThrow()
    expect(response.bodyUsed).toBe(true)
    expect(response.body!.locked).toBe(false)
    expect(await response.body!.getReader().read()).toEqual({ done: true, value: undefined })
  }
)
