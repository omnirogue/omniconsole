import { afterEach, expect, it, vi } from 'vitest'
import { readBackofficeCached } from './backoffice-read-cache'
afterEach(() => vi.unstubAllGlobals())
it('sends the validator, returns explicit 304 and never parses its body', async () => {
  const unchanged = new Response(null, { status: 304 })
  const json = vi.spyOn(unchanged, 'json')
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{"items":[]}', { headers: { etag: '"v1"' } }))
    .mockResolvedValueOnce(unchanged)
  vi.stubGlobal('fetch', fetch)
  const first = await readBackofficeCached('https://test/todo', 'account-one')
  const next = await readBackofficeCached('https://test/todo', 'account-one')
  expect(next.notModified).toBe(true)
  expect(next.body).toBe(first.body)
  expect(json).not.toHaveBeenCalled()
  expect(fetch.mock.calls[1][1].headers['If-None-Match']).toBe('"v1"')
})
it('isolates credentials and coalesces concurrent reads', async () => {
  const fetch = vi.fn(async () => new Response('{}', { headers: { etag: '"v1"' } }))
  vi.stubGlobal('fetch', fetch)
  await Promise.all([
    readBackofficeCached('https://test/peers', 'a'),
    readBackofficeCached('https://test/peers', 'a')
  ])
  expect(fetch).toHaveBeenCalledTimes(1)
  await readBackofficeCached('https://test/peers', 'b')
  expect(fetch).toHaveBeenLastCalledWith(
    'https://test/peers',
    expect.objectContaining({ headers: { accept: 'application/json', Authorization: 'Bearer b' } })
  )
})
it('gives concurrent error readers independent bodies for authentication classification', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"error":"hub unavailable"}', { status: 401 }))
  )
  const reads = await Promise.all([
    readBackofficeCached('https://test/error'),
    readBackofficeCached('https://test/error')
  ])
  const bodies = await Promise.all(reads.map((read) => read.response.json()))
  expect(bodies).toEqual([{ error: 'hub unavailable' }, { error: 'hub unavailable' }])
})
it('cancels an unreadable 410 stream once across concurrent callers', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }), { status: 410 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  const reads = await Promise.all([
    readBackofficeCached('https://test/expired'),
    readBackofficeCached('https://test/expired')
  ])
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(reads.map((read) => read.response.status)).toEqual([410, 410])
  expect(reads.every((read) => read.response.body === null)).toBe(true)
})
