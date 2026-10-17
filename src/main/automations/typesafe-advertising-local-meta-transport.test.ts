import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import {
  createLocalMetaReader,
  type LocalMetaReaderIdentity
} from './typesafe-advertising-local-meta-transport'

const TOKEN = 'private-meta-token'
const ERROR = 'Local Meta evidence is unavailable.'
const PATH = '12345/insights'
const BASE = `https://graph.facebook.com/v21.0/${PATH}`
const PARAMS = { fields: 'spend,actions', limit: '100', date_preset: 'today' }

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function reader(fetcher: typeof globalThis.fetch, identity: Partial<LocalMetaReaderIdentity> = {}) {
  return createLocalMetaReader(
    { token: TOKEN, isCurrent: () => true, ...identity },
    { fetch: fetcher }
  )
}

function page(after: string, rows: unknown[] = [{ spend: '3' }]): Response {
  return json({
    data: rows,
    paging: { cursors: { after }, next: `${BASE}?after=${after}` }
  })
}

afterEach(() => {
  vi.useRealTimers()
  setMainHttpClient(null)
})

describe('local Meta transport request boundaries', () => {
  it('reads native controls directly, using only header authentication and the fixed GET endpoint', async () => {
    const value = { id: '12345', account_id: '1000000000000001', status: 'ACTIVE' }
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value))
    const now = () => Date.parse('2026-09-20T12:00:00Z')
    const client = createLocalMetaReader(
      { token: TOKEN, isCurrent: () => true },
      { fetch: fetcher, now }
    )
    expect(await client.get('/12345', { fields: 'id,account_id,status' })).toEqual({
      value,
      collectedAt: '2026-09-20T12:00:00.000Z'
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/12345?fields=id%2Caccount_id%2Cstatus',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: expect.any(AbortSignal)
      })
    )
    expect(fetcher.mock.calls[0][0]).not.toContain(TOKEN)
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
  })

  it('uses the existing main-process HTTP port by default', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ id: '12345' }))
    setMainHttpClient({ fetch: fetcher, proxySession: () => null })
    await createLocalMetaReader({ token: TOKEN, isCurrent: () => true }).get('12345', {})
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://example.invalid/12345',
    '//12345',
    '../12345',
    '12345/ads',
    'me',
    'batch',
    'act_999',
    '12345?access_token=secret',
    '12345#fragment',
    '12345/insights/extra',
    '12345%2Finsights',
    '123',
    '0',
    '1'.repeat(31)
  ])('rejects unsafe paths before fetching: %s', async (path) => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(reader(fetcher).get(path, {})).rejects.toThrow(ERROR)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each<Record<string, string>>([
    { access_token: TOKEN },
    { method: 'POST' },
    { fields: 'ads.limit(100){id}' },
    { limit: '101' },
    { limit: '-1' },
    { after: 'cursor&access_token=secret' },
    { level: 'business' },
    { date_preset: 'today&method=POST' },
    { time_increment: '91' },
    { action_report_time: 'unsupported' },
    { use_account_attribution_setting: '1' },
    { constructor: 'anything' }
  ])('rejects unsupported params before fetching: %j', async (params) => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(reader(fetcher).get('12345', params)).rejects.toThrow(ERROR)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts the fixed account and attribution params', async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ id: '1000000000000001' }))
    await reader(fetcher).get('act_1000000000000001', {
      fields: 'id,currency',
      action_report_time: 'conversion',
      use_account_attribution_setting: 'true'
    })
    expect(String(fetcher.mock.calls[0][0])).toContain('/v21.0/act_1000000000000001?')
  })

  it.each([400, 401, 403, 429, 500])(
    'fails on HTTP %s without retry or provider error reflection',
    async (status) => {
      const cancelled = vi.fn()
      const body = new ReadableStream({
        start: (control) => control.enqueue(new TextEncoder().encode(TOKEN)),
        cancel: cancelled
      })
      const fetcher = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { status }))
      const client = reader(fetcher)
      await expect(client.get('12345', {})).rejects.toThrow(ERROR)
      await expect(client.get('12345', {})).rejects.toThrow(ERROR)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(cancelled).toHaveBeenCalled()
    }
  )

  it('does not reflect fetch errors, JSON parse errors, or provider error objects', async () => {
    for (const fetcher of [
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`${TOKEN} ${BASE}`)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`invalid ${TOKEN}`)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { message: TOKEN } }))
    ]) {
      await expect(reader(fetcher).get('12345', {})).rejects.toThrow(new Error(ERROR))
    }
  })

  it.each(['redirected', 'url'])(
    'rejects a response whose %s escaped the requested URL',
    async (field) => {
      const response = json({ id: '12345' })
      Object.defineProperty(response, field, {
        value: field === 'url' ? 'https://example.invalid/' : true
      })
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      await expect(reader(fetcher).get('12345', {})).rejects.toThrow(ERROR)
      expect(response.bodyUsed).toBe(true)
    }
  )
})

describe('local Meta pagination', () => {
  it('reconstructs subsequent requests from the original params and safe cursor', async () => {
    const next = new URL(BASE)
    next.searchParams.set('after', 'cursor-one')
    next.searchParams.set('access_token', 'provider-echoed-secret')
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          data: [{ spend: '1' }],
          paging: { cursors: { after: 'cursor-one' }, next: next.href }
        })
      )
      .mockResolvedValueOnce(
        json({ data: [{ spend: '2' }], paging: { cursors: { after: 'terminal' } } })
      )
    const result = await reader(fetcher).list(PATH, PARAMS)
    expect(result.rows).toEqual([{ spend: '1' }, { spend: '2' }])
    const requested = new URL(String(fetcher.mock.calls[1][0]))
    expect(Object.fromEntries(requested.searchParams)).toEqual({ ...PARAMS, after: 'cursor-one' })
    expect(requested.href).not.toContain('secret')
    expect(requested.href).not.toContain(TOKEN)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://example.invalid/v21.0/12345/insights?after=c1',
    'http://graph.facebook.com/v21.0/12345/insights?after=c1',
    'https://graph.facebook.com/v20.0/12345/insights?after=c1',
    'https://graph.facebook.com/v21.0/67890/insights?after=c1',
    'https://person@graph.facebook.com/v21.0/12345/insights?after=c1',
    `${BASE}?after=c1#fragment`,
    `${BASE}?after=c1&after=c1`,
    `${BASE}?after=c1&method=POST`,
    `${BASE}?after=c1&limit=1`,
    `${BASE}?after=c1&fields=unrequested`,
    `${BASE}?after=c1&access_token=a&access_token=b`,
    `${BASE}?after=cursor%26malicious`,
    `${BASE}?limit=100`,
    '/v21.0/12345/insights?after=c1'
  ])('refuses unsafe next links without following them: %s', async (next) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        data: [{ spend: '1' }],
        paging: { cursors: { after: 'c1' }, next }
      })
    )
    await expect(reader(fetcher).list(PATH, PARAMS)).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    { data: [], paging: { cursors: { after: 'c1' }, next: `${BASE}?after=c1` } },
    { data: [{}], paging: { next: `${BASE}?after=c1` } },
    { data: [{}], paging: { cursors: { after: 'other' }, next: `${BASE}?after=c1` } },
    { data: [{}], paging: { next: null } },
    { data: [{}], paging: [] },
    { data: [{}], paging: { total: 99 } },
    { data: [{}], paging: { cursors: { after: '' } } },
    { data: [{}], paging: { previous: 'https://example.invalid?before=c1' } },
    { data: [{}], summary: { total_count: 100 } },
    { data: {} },
    { id: '12345' },
    { data: [null] }
  ])('rejects malformed or incomplete page envelopes: %j', async (body) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body))
    await expect(reader(fetcher).list(PATH, PARAMS)).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('allows valid previous links without ever fetching them', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        data: [{}],
        paging: { cursors: { before: 'b1' }, previous: `${BASE}?before=b1` }
      })
    )
    expect((await reader(fetcher).list(PATH, PARAMS)).rows).toEqual([{}])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects cursor loops, including a caller-provided starting cursor', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => page('c1'))
    await expect(reader(fetcher).list(PATH, PARAMS)).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockClear()
    await expect(reader(fetcher).list(PATH, { ...PARAMS, after: 'c1' })).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails after five pages with more data instead of returning partial rows', async () => {
    let count = 0
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => page(`c${++count}`))
    await expect(reader(fetcher).list(PATH, PARAMS)).rejects.toThrow(ERROR)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('rejects more than 100 rows and exactly 100 rows when paging is incomplete', async () => {
    for (const response of [
      json({ data: Array.from({ length: 101 }, () => ({})) }),
      page(
        'c1',
        Array.from({ length: 100 }, () => ({}))
      )
    ]) {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      await expect(reader(fetcher).list(PATH, PARAMS)).rejects.toThrow(ERROR)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
})
