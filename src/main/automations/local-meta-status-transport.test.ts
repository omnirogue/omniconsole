import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'
import { setMainHttpClient } from '../network/http-client'
import { META_IDS, metaTarget } from './local-meta-fixtures'
import { createLocalMetaStatusWriter } from './local-meta-status-transport'

const TOKEN = 'private-meta-status-fixture-token'
const ERROR = 'Local Meta status change is unverified.'
const NOW = Date.parse('2026-09-20T12:00:00.000Z')

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function writer(fetcher: typeof globalThis.fetch) {
  return createLocalMetaStatusWriter(
    { token: TOKEN, isCurrent: () => true, assertCurrent: async () => {} },
    { fetch: fetcher, now: () => NOW }
  )
}

afterEach(() => {
  setMainHttpClient(null)
})

describe('local Meta status request boundary', () => {
  it.each([
    ['ad', 'ACTIVE'],
    ['ad', 'PAUSED'],
    ['adset', 'ACTIVE'],
    ['adset', 'PAUSED']
  ] as const)(
    'sends only the approved %s status %s to the fixed endpoint',
    async (type, status) => {
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ success: true }))
      const result = await writer(fetcher).send(metaTarget(type), status)
      expect(result).toEqual({
        accepted: true,
        reference: null,
        respondedAt: new Date(NOW).toISOString()
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      const [url, request] = fetcher.mock.calls[0]
      expect(url).toBe(`https://graph.facebook.com/v21.0/${META_IDS[type]}`)
      expect(request).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: expect.any(AbortSignal)
        })
      )
      const body = request?.body
      expect(body).toBeInstanceOf(URLSearchParams)
      expect(Array.from((body as URLSearchParams).entries())).toEqual([['status', status]])
      expect(String(url)).not.toContain(TOKEN)
      expect(String(request?.body)).not.toContain(TOKEN)
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    }
  )

  it('uses the existing main-process HTTP port when no fetch override is supplied', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ success: true }))
    setMainHttpClient({ fetch: fetcher, proxySession: () => null })
    await createLocalMetaStatusWriter({
      token: TOKEN,
      isCurrent: () => true,
      assertCurrent: async () => {}
    }).send(metaTarget(), 'PAUSED')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '', ' ', 'token\r\nInjected: yes', 'token secret', 'a'.repeat(4097)])(
    'rejects unusable header credentials without a request',
    async (token) => {
      const fetcher = vi.fn<typeof globalThis.fetch>()
      const client = createLocalMetaStatusWriter(
        { token: token as string, isCurrent: () => true, assertCurrent: async () => {} },
        { fetch: fetcher }
      )
      await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each([
    { company: 'betacorp' },
    { accountId: 'act_123456789' },
    { accountId: '1000000000000001' },
    { objectType: 'campaign', nativeId: META_IDS.campaign, adsetId: null },
    { objectType: 'account' },
    { nativeId: 'https://example.invalid/12345' },
    { nativeId: '../12345' },
    { nativeId: '12345?status=ACTIVE' },
    { nativeId: '12345#fragment' },
    { nativeId: '12345/ads' },
    { nativeId: '12345%2Fads' },
    { nativeId: '0' },
    { nativeId: '1234' },
    { nativeId: '1'.repeat(31) },
    { nativeId: META_IDS.campaign, adsetId: META_IDS.campaign },
    { campaignId: META_IDS.adset },
    { campaignId: '1000000000000001' },
    { nativeId: '1000000000000001', adsetId: '1000000000000001' },
    { adsetId: null },
    { adsetId: META_IDS.ad },
    { status: 'ACTIVE' },
    { daily_budget: '100' },
    { access_token: TOKEN },
    { method: 'DELETE' },
    { url: 'https://example.invalid/' }
  ])('rejects invalid scope, hierarchy and extra target fields: %j', async (patch) => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(
      writer(fetcher).send({ ...metaTarget(), ...patch } as AdvertisingTarget, 'PAUSED')
    ).rejects.toThrow(new Error(ERROR))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    { nativeId: META_IDS.adset },
    { nativeId: META_IDS.campaign },
    { adsetId: META_IDS.campaign },
    { adsetId: null },
    { adsetId: '1000000000000001' }
  ])('rejects an ad with overlapping or missing parent identities: %j', async (patch) => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(
      writer(fetcher).send({ ...metaTarget('ad'), ...patch } as AdvertisingTarget, 'ACTIVE')
    ).rejects.toThrow(new Error(ERROR))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    'DELETED',
    'ARCHIVED',
    'active',
    'ACTIVE&daily_budget=100',
    '',
    null,
    { status: 'ACTIVE' }
  ])('rejects unsupported or injected status %j before network activity', async (status) => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    await expect(writer(fetcher).send(metaTarget(), status as 'ACTIVE')).rejects.toThrow(
      new Error(ERROR)
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('local Meta status one-shot admission', () => {
  it('cannot submit a second mutation after a successful response', async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ success: true }))
    const client = writer(fetcher)
    await client.send(metaTarget(), 'PAUSED')
    await expect(client.send(metaTarget(), 'ACTIVE')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['scope', 'status'] as const)(
    'consumes admission even when the first %s is invalid',
    async (invalid) => {
      const fetcher = vi.fn<typeof globalThis.fetch>()
      const client = writer(fetcher)
      await expect(
        client.send(
          invalid === 'scope' ? { ...metaTarget(), accountId: 'act_12345' } : metaTarget(),
          (invalid === 'status' ? 'DELETED' : 'PAUSED') as 'PAUSED'
        )
      ).rejects.toThrow(new Error(ERROR))
      await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('admits at most one concurrent caller before any authority await resolves', async () => {
    let releaseAuthority = (): void => {}
    const authority = new Promise<void>((resolve) => {
      releaseAuthority = resolve
    })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ success: true }))
    const client = createLocalMetaStatusWriter(
      {
        token: TOKEN,
        isCurrent: () => true,
        assertCurrent: () => authority
      },
      { fetch: fetcher }
    )
    const first = client.send(metaTarget(), 'PAUSED')
    await expect(client.send(metaTarget(), 'ACTIVE')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).not.toHaveBeenCalled()
    releaseAuthority()
    await expect(first).resolves.toMatchObject({ accepted: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('captures the target before awaiting authority rather than reading later caller mutations', async () => {
    let releaseAuthority = (): void => {}
    const authority = new Promise<void>((resolve) => {
      releaseAuthority = resolve
    })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ success: true }))
    const target = metaTarget()
    const client = createLocalMetaStatusWriter(
      { token: TOKEN, isCurrent: () => true, assertCurrent: () => authority },
      { fetch: fetcher }
    )
    const result = client.send(target, 'PAUSED')
    target.nativeId = META_IDS.ad
    target.adsetId = META_IDS.ad
    releaseAuthority()
    await expect(result).resolves.toMatchObject({ accepted: true })
    expect(fetcher.mock.calls[0][0]).toBe(`https://graph.facebook.com/v21.0/${META_IDS.adset}`)
  })
})

describe('local Meta status response boundary', () => {
  it.each(['trace_1-Z', 'a'.repeat(200)])(
    'returns only a bounded safe trace reference: %s',
    async (reference) => {
      const fetcher = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({ success: true, fbtrace_id: reference }))
      expect(await writer(fetcher).send(metaTarget(), 'PAUSED')).toEqual({
        accepted: true,
        reference,
        respondedAt: new Date(NOW).toISOString()
      })
    }
  )

  it.each([
    null,
    true,
    [],
    {},
    { success: false },
    { success: 1 },
    { success: 'true' },
    { success: true, error: null },
    { success: true, error: { message: TOKEN } },
    { success: true, id: META_IDS.adset },
    { success: true, message: TOKEN },
    { success: true, fbtrace_id: null },
    { success: true, fbtrace_id: 123 },
    { success: true, fbtrace_id: '' },
    { success: true, fbtrace_id: 'a'.repeat(201) },
    { success: true, fbtrace_id: 'space separated' },
    { success: true, fbtrace_id: 'unsafe/path' },
    { success: true, fbtrace_id: 'trace\nnewline' },
    { success: true, fbtrace_id: 'trace=secret' }
  ])('refuses malformed, ambiguous or extra-field responses: %j', async (value) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value))
    const client = writer(fetcher)
    await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([301, 302, 400, 401, 403, 429, 500, 503])(
    'never retries or reflects HTTP %s error bodies',
    async (status) => {
      const cancelled = vi.fn()
      const response = new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode(TOKEN)),
          cancel: cancelled
        }),
        { status }
      )
      const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
      const client = writer(fetcher)
      await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      await expect(client.send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(cancelled).toHaveBeenCalled()
    }
  )

  it('does not disclose thrown provider errors or invalid JSON', async () => {
    for (const fetcher of [
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error(`${TOKEN} https://example.invalid/`)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`invalid ${TOKEN}`))
    ]) {
      await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    '{"success":false,"success":true}',
    '{"fbtrace_id":"bad value","success":true,"fbtrace_id":"safe"}'
  ])('refuses duplicate response fields even when the last value appears valid', async (body) => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body))
    await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses a provider reference that echoes the header credential', async () => {
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ success: true, fbtrace_id: `trace-${TOKEN}` }))
    await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
  })

  it.each(['redirected', 'url'])('refuses a response with an escaped %s', async (field) => {
    const response = json({ success: true })
    Object.defineProperty(response, field, {
      value: field === 'url' ? 'https://example.invalid/' : true
    })
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    await expect(writer(fetcher).send(metaTarget(), 'PAUSED')).rejects.toThrow(new Error(ERROR))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(true)
  })
})
