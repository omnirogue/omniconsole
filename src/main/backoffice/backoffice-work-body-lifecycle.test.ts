import { afterEach, expect, it, vi } from 'vitest'
import { archiveBackofficeTask, completeBackofficeTask } from './backoffice-work'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: async () => 'test-token' }))
vi.mock('./backoffice-config', () => ({
  getBackofficeSnapshot: () => ({ configured: true, baseUrl: 'https://body.test', message: '' })
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({ getOrcaCloudAuthConfig: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: vi.fn()
}))
vi.mock('../omni-profiles/profile-cloud-client', () => ({ OrcaCloudRequestError: class {} }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([200, 401, 403, 410, 500])(
  'archive cancels an unread HTTP %s body exactly once',
  async (status) => {
    const cancel = vi.fn()
    const response = cancelTrackingResponse(status, cancel)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    const result = await archiveBackofficeTask('btk_AbC123')
    expect(result.ok).toBe(status === 200)
    expect(cancel).toHaveBeenCalledTimes(1)
  }
)

it.each([200, 401, 403])(
  'completion cancels an unread HTTP %s body exactly once',
  async (status) => {
    const cancel = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => cancelTrackingResponse(status, cancel))
    )
    const result = await completeBackofficeTask('btk_AbC123', 3)
    expect(result.ok).toBe(status === 200)
    expect(cancel).toHaveBeenCalledTimes(1)
  }
)

it('completion cancels a refusal whose reader setup fails', async () => {
  const cancel = vi.fn()
  const response = cancelTrackingResponse(500, cancel)
  vi.spyOn(response.body!, 'getReader').mockImplementationOnce(() => {
    throw new Error('reader failed')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response)
  )
  await expect(completeBackofficeTask('btk_AbC123', 3)).resolves.toEqual({
    ok: false,
    message: 'The backoffice answered HTTP 500.'
  })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each(['{"detail":"refused"}', '{malformed'])(
  'completion consumes a JSON refusal or parse failure: %s',
  async (body) => {
    const response = new Response(body, { status: 500 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    expect((await completeBackofficeTask('btk_AbC123', 3)).ok).toBe(false)
    expect(response.bodyUsed).toBe(true)
    expect(response.body!.locked).toBe(false)
    expect(await response.body!.getReader().read()).toEqual({ done: true, value: undefined })
  }
)

it('handles a fetch abort before any response is acquired', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
  await expect(archiveBackofficeTask('btk_AbC123')).resolves.toMatchObject({ ok: false })
  await expect(completeBackofficeTask('btk_AbC123', 3)).resolves.toMatchObject({ ok: false })
})
