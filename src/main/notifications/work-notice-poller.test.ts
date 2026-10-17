import { describe, expect, it, vi } from 'vitest'
import { WorkNoticePoller, type WorkNoticeCursor, type WorkNoticeScope } from './work-notice-poller'
import { workNoticeClickUrl } from './work-notice-url'

function fixture() {
  let time = 0
  let enabled = true
  let signedIn = true
  let cursor: WorkNoticeCursor = { after: null, pending: null, seen: [] }
  const item = {
    id: 12,
    event: 'assigned',
    title: 'Review',
    body: 'Waiting on you',
    url: 'https://console.example.com/a/test',
    created_at: '2026-10-12T00:00:00Z'
  }
  const request = vi.fn(async (_path: string, _id?: string | number): Promise<unknown> => ({
    items: [item, item],
    next_after: 12
  }))
  const dispatch = vi.fn(async () => ({ delivered: true }))
  const scope: WorkNoticeScope = {
    key: 'profile-one',
    current: () => signedIn,
    request,
    read: () => structuredClone(cursor),
    write: (value) => {
      cursor = structuredClone(value)
    }
  }
  const create = () =>
    new WorkNoticePoller({
      enabled: () => enabled,
      scope: () => (signedIn ? scope : null),
      dispatch,
      now: () => time
    })
  return {
    request,
    dispatch,
    create,
    scope,
    item,
    cursor: () => cursor,
    advance: (ms: number) => {
      time += ms
    },
    disable: () => {
      enabled = false
    },
    signOut: () => {
      signedIn = false
    }
  }
}

describe('Work notices', () => {
  it('dedupes a batch and persists the acked cursor across restart', async () => {
    const f = fixture()
    await f.create().tick()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'work-notice',
        workNoticeTitle: 'Review',
        workNoticeBody: 'Waiting on you'
      })
    )
    expect(f.cursor().after).toBe(12)
    expect(f.request).toHaveBeenCalledWith('/v1/me/notifications/ack', 12)
    await f.create().tick()
    expect(f.request).toHaveBeenCalledWith('/v1/me/notifications?after=12&limit=50')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('retries a failed ack after restart without redispatch', async () => {
    const f = fixture()
    f.request.mockImplementation(async (path) => {
      if (path.endsWith('/ack')) {
        throw new Error('offline')
      }
      return { items: [f.item], next_after: 12 }
    })
    await f.create().tick()
    expect(f.cursor()).toMatchObject({ after: null, pending: 12 })
    f.request.mockResolvedValue({ items: [], next_after: 12 })
    await f.create().tick()
    expect(f.cursor()).toMatchObject({ after: 12, pending: null })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('keeps polling on the next sixty-second tick after a slow fetch', async () => {
    const f = fixture()
    f.request.mockImplementation(async () => {
      f.advance(1000)
      return { items: [], next_after: null }
    })
    const poller = f.create()
    await poller.tick()
    f.advance(59_000)
    await poller.tick()
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('silently backs off a 404 for thirty minutes', async () => {
    const f = fixture()
    const poller = f.create()
    f.request.mockRejectedValue({ statusCode: 404 })
    await poller.tick()
    f.advance(29 * 60_000)
    await poller.tick()
    expect(f.request).toHaveBeenCalledTimes(1)
    f.advance(60_000)
    await poller.tick()
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('does not fetch, dispatch or ack while disabled or signed out', async () => {
    const f = fixture()
    f.disable()
    await f.create().tick()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    const signedOut = fixture()
    signedOut.signOut()
    await signedOut.create().tick()
    expect(signedOut.request).not.toHaveBeenCalled()
  })

  it('drops an in-flight response after sign-out or a toggle change', async () => {
    for (const change of ['signOut', 'disable'] as const) {
      const f = fixture()
      f.request.mockImplementation(async () => {
        f[change]()
        return { items: [f.item], next_after: 12 }
      })
      await f.create().tick()
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.cursor().after).toBeNull()
      expect(f.request).toHaveBeenCalledTimes(1)
    }
  })

  it('delivers each distinct item in a burst and prevents overlapping fetches', async () => {
    const f = fixture()
    f.request.mockResolvedValue({ items: [f.item, { ...f.item, id: 13 }], next_after: 13 })
    const poller = f.create()
    await Promise.all([poller.tick(), poller.tick()])
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.cursor().after).toBe(13)
  })
})

describe('Work notice click URL', () => {
  it.each([
    'https://console.example.com/a/review',
    'https://example-team.atlassian.net/browse/OAOS-1'
  ])('accepts %s', (url) => {
    expect(workNoticeClickUrl(url)).toBe(url)
  })
  it.each([
    'http://console.example.com/a',
    'https://console.example.com.evil.test/',
    'https://console.example.com@evil.test/',
    'https://user@console.example.com/',
    'https://console.example.com:8443/',
    'javascript:alert(1)',
    'invalid'
  ])('falls back to Work for %s', (url) => {
    expect(workNoticeClickUrl(url)).toBe('https://console.example.com/work')
  })
})
