import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { archiveBackofficeTask } from './backoffice-work'
import { getBackofficeSnapshot } from './backoffice-config'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'

vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: vi.fn(() => ({ configured: false }))
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: vi.fn()
}))

const CONFIGURED = { configured: true as const, baseUrl: 'https://omnios.example.com', message: '' }
const TASK = 'btk_00f0e485b48440dd93dc'

describe('archiveBackofficeTask', () => {
  beforeEach(() => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue(CONFIGURED as never)
    vi.mocked(getOrcaCloudAuthConfig).mockReturnValue({ configured: false } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('posts to the card archive path with an empty body', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(archiveBackofficeTask(TASK)).resolves.toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://omnios.example.com/api/board/${TASK}/archive`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    // A redirect would take the bearer somewhere the operator never named.
    expect(init.redirect).toBe('error')
  })

  it('refuses an id that is not a board card before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await archiveBackofficeTask('ses_1234')

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when no backoffice is configured', async () => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue({
      configured: false,
      message: 'Set a backoffice URL first.'
    } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await archiveBackofficeTask(TASK)

    expect(result).toEqual({ ok: false, message: 'Set a backoffice URL first.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains a refusal as a sign-in problem, not a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))

    const result = await archiveBackofficeTask(TASK)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('Sign in')
  })

  it('reports an unreachable backoffice with its own message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      })
    )

    const result = await archiveBackofficeTask(TASK)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('connect ECONNREFUSED')
  })
})
