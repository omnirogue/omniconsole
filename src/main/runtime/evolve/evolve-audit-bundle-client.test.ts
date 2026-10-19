import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSharedOmniRogueAccountLease } from '../../omnirogue-account/omnirogue-account-lease'
import {
  EvolveAuditBundleHttpError,
  fetchEvolveAuditBundle,
  type EvolveAuditBundleClientDeps
} from './evolve-audit-bundle-client'

const account = vi.hoisted(() => ({ leaseToken: vi.fn(() => 'existing-session') }))
vi.mock('../../omnirogue-account/omnirogue-account-lease', () => ({
  getSharedOmniRogueAccountLease: vi.fn(() => account)
}))

function setup(response = Response.json({ run_id: 'run-1', evidence: [] })) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
  const leaseToken = vi.fn(() => ' test-token ')
  const deps = { baseUrl: 'https://cloud.example', fetchImpl, leaseToken }
  return { deps, fetchImpl, leaseToken }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('fetchEvolveAuditBundle', () => {
  it('reads a bounded authenticated bundle and retains unknown service fields', async () => {
    const bundle = { run_id: 'run:1', audit: { passed: false }, future_field: ['evidence'] }
    const { deps, fetchImpl, leaseToken } = setup(Response.json(bundle))
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await expect(fetchEvolveAuditBundle(' run:1 ', deps)).resolves.toEqual(bundle)
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'https://cloud.example/api/evolve/runs/run%3A1/audit-bundle',
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer test-token' },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      }
    )
    expect(timeout).toHaveBeenCalledWith(20_000)
    expect(leaseToken).toHaveBeenCalledOnce()
  })

  it.each(['', ' ', '.', '..', '../run', 'run/id', 'run?id', 'run#id', '%2e%2e', 'x'.repeat(129)])(
    'refuses invalid run ID %j before authentication or network access',
    async (runId) => {
      const { deps, fetchImpl, leaseToken } = setup()
      await expect(fetchEvolveAuditBundle(runId, deps)).rejects.toThrow('Invalid hosted Evolve')
      expect(leaseToken).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([
    'http://cloud.example',
    'ftp://localhost',
    'file:///tmp/audit',
    'https://user:secret@cloud.example',
    'http://localhost.evil.example',
    'not a URL'
  ])('refuses unsafe endpoint %s before resolving credentials', async (baseUrl) => {
    const { deps, fetchImpl, leaseToken } = setup()
    await expect(fetchEvolveAuditBundle('run-1', { ...deps, baseUrl })).rejects.toThrow()
    expect(leaseToken).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])(
    'allows local development on %s',
    async (baseUrl) => {
      const { deps, fetchImpl } = setup()
      await fetchEvolveAuditBundle('run-1', { ...deps, baseUrl })
      expect(fetchImpl.mock.calls[0][0]).toBe(`${baseUrl}/api/evolve/runs/run-1/audit-bundle`)
    }
  )

  it('uses only the configured origin and a fixed audit route', async () => {
    const { deps, fetchImpl } = setup()
    await fetchEvolveAuditBundle('run-1', {
      ...deps,
      baseUrl: 'https://cloud.example/prefix?query=ignored#fragment'
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://cloud.example/api/evolve/runs/run-1/audit-bundle'
    )
  })

  it('uses the cloud environment override and prefers an explicit endpoint', async () => {
    vi.stubEnv('OMNISI_CLOUD_URL', 'https://environment.example')
    const { deps, fetchImpl } = setup()
    await fetchEvolveAuditBundle('run-1', { ...deps, baseUrl: undefined })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://environment.example/api/evolve/runs/run-1/audit-bundle'
    )
    fetchImpl.mockResolvedValueOnce(Response.json({}))
    await fetchEvolveAuditBundle('run-1', deps)
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://cloud.example/api/evolve/runs/run-1/audit-bundle'
    )
  })

  it('uses the default cloud, fetch and shared account lease', async () => {
    vi.stubEnv('OMNISI_CLOUD_URL', undefined)
    const { fetchImpl } = setup()
    vi.stubGlobal('fetch', fetchImpl)
    await fetchEvolveAuditBundle('run-1')
    expect(getSharedOmniRogueAccountLease).toHaveBeenCalledOnce()
    expect(account.leaseToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.omnisi.ai/api/evolve/runs/run-1/audit-bundle',
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: 'Bearer existing-session' }
      })
    )
  })

  it.each([null, '', '   '])('refuses an empty lease %j without fetching', async (token) => {
    const { deps, fetchImpl } = setup()
    await expect(
      fetchEvolveAuditBundle('run-1', {
        ...deps,
        leaseToken: async () => token
      })
    ).rejects.toThrow('Connect your OmniRogue account')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([401, 403])('preserves the account on HTTP %i without retrying', async (status) => {
    const response = new Response('private error', { status })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const { deps, fetchImpl } = setup(response)
    await expect(
      fetchEvolveAuditBundle('run-1', {
        ...deps,
        leaseToken: undefined
      })
    ).rejects.toThrow(`rejected token (${status}); existing OmniRogue session preserved`)
    expect(getSharedOmniRogueAccountLease).toHaveBeenCalledOnce()
    expect(account.leaseToken).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([302, 404, 405, 429, 500])(
    'reports HTTP %i without returning an empty bundle',
    async (status) => {
      const response = new Response('upstream details', { status })
      const cancel = vi.spyOn(response.body!, 'cancel')
      const { deps, fetchImpl } = setup(response)
      const result = fetchEvolveAuditBundle('run-1', deps)
      await expect(result).rejects.toBeInstanceOf(EvolveAuditBundleHttpError)
      await expect(result).rejects.toMatchObject({
        status,
        message: expect.stringContaining(`HTTP ${status}`)
      })
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )

  it.each([null, [], true, 123, 'bundle'].map((body) => ({ body })))(
    'rejects a non-object response $body',
    async ({ body }) => {
      const { deps } = setup(Response.json(body))
      await expect(fetchEvolveAuditBundle('run-1', deps)).rejects.toThrow('must be a JSON object')
    }
  )

  it('rejects malformed JSON', async () => {
    const { deps } = setup(new Response('{invalid'))
    await expect(fetchEvolveAuditBundle('run-1', deps)).rejects.toThrow(SyntaxError)
  })

  it.each([true, false])('rejects oversized bodies (declared size: %s)', async (declared) => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1_048_577)))
      },
      cancel
    })
    const { deps } = setup(
      new Response(stream, {
        headers: declared ? { 'content-length': '1048577' } : undefined
      })
    )
    await expect(fetchEvolveAuditBundle('run-1', deps)).rejects.toThrow(
      'exceeds 1048576 byte limit'
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses an already-aborted request before resolving the lease', async () => {
    const { deps, fetchImpl, leaseToken } = setup()
    const reason = new Error('cancelled')
    await expect(
      fetchEvolveAuditBundle('run-1', {
        ...deps,
        signal: AbortSignal.abort(reason)
      })
    ).rejects.toBe(reason)
    expect(leaseToken).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not fetch if cancelled while resolving the lease', async () => {
    const { deps, fetchImpl } = setup()
    const controller = new AbortController()
    const reason = new Error('cancelled during authentication')
    const options: EvolveAuditBundleClientDeps = {
      ...deps,
      signal: controller.signal,
      leaseToken: async () => {
        controller.abort(reason)
        return 'token'
      }
    }
    await expect(fetchEvolveAuditBundle('run-1', options)).rejects.toBe(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards cancellation to the request signal', async () => {
    const { deps, fetchImpl } = setup()
    const controller = new AbortController()
    fetchImpl.mockImplementationOnce(async (_url, init) => {
      controller.abort(new Error('cancelled during fetch'))
      init?.signal?.throwIfAborted()
      return Response.json({})
    })
    await expect(
      fetchEvolveAuditBundle('run-1', {
        ...deps,
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled during fetch')
  })

  it('propagates network errors without retrying', async () => {
    const { deps, fetchImpl } = setup()
    const error = new TypeError('network unavailable')
    fetchImpl.mockRejectedValueOnce(error)
    await expect(fetchEvolveAuditBundle('run-1', deps)).rejects.toBe(error)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
