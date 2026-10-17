import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBackofficeFeed } from './backoffice-work'
import { getBackofficeSnapshot } from './backoffice-config'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'

vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: vi.fn()
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: vi.fn()
}))

const PATH = '/api/estate/peers/projects'
const session = (accessToken: string) => ({ accessToken }) as never

describe('backoffice feed authentication', () => {
  beforeEach(() => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue({
      configured: true,
      baseUrl: 'https://omnios.example.com',
      message: ''
    } as never)
    vi.mocked(getOrcaCloudAuthConfig).mockReturnValue({ configured: true, config: {} } as never)
    vi.mocked(runWithFreshOrcaCloudSession).mockImplementation(
      async (_config, _active, _path, operation) => ({
        status: 'ok',
        value: await operation(session('first-token'))
      })
    )
  })
  afterEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  it('runs the rejected request inside the refresh boundary and retries with its new token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ projects: [] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(runWithFreshOrcaCloudSession).mockImplementation(
      async (_config, _active, _path, operation) => {
        await expect(operation(session('first-token'))).rejects.toMatchObject({ statusCode: 401 })
        return { status: 'ok', value: await operation(session('refreshed-token')) }
      }
    )
    await expect(fetchBackofficeFeed(PATH)).resolves.toEqual({ ok: true, body: { projects: [] } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer first-token')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer refreshed-token')
    expect(fetchMock.mock.calls[1][1].redirect).toBe('error')
  })

  it('directs a missing or rejected session to account sign-in without an anonymous production retry', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(runWithFreshOrcaCloudSession).mockResolvedValue({ status: 'reconnect-required' })
    expect(await fetchBackofficeFeed(PATH)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Settings → OmniConsole Account')
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not refresh or sign out an account that lacks permission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchBackofficeFeed(PATH)).toEqual({
      ok: false,
      message: 'Your account does not have access to this feed (HTTP 403).'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps local anonymous read-only backoffices available', async () => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue({
      configured: true,
      baseUrl: 'http://127.0.0.1:4477'
    } as never)
    vi.mocked(runWithFreshOrcaCloudSession).mockResolvedValue({ status: 'reconnect-required' })
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ projects: [] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchBackofficeFeed(PATH)).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })

  it('does not downgrade to anonymous when refreshing fails due to connectivity', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(runWithFreshOrcaCloudSession).mockRejectedValue(new Error('Connection unavailable'))
    expect(await fetchBackofficeFeed(PATH)).toEqual({
      ok: false,
      message: 'Connection unavailable'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not refresh or revoke the desktop session for a relayed hub authentication failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: 'Hub credential rejected' } }, { status: 401 })
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchBackofficeFeed(PATH)).toMatchObject({
      ok: false,
      message: expect.stringContaining('authenticate with the hub')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('blocks unapproved paths before reading credentials', async () => {
    expect(await fetchBackofficeFeed('/api/private')).toMatchObject({ ok: false })
    expect(runWithFreshOrcaCloudSession).not.toHaveBeenCalled()
  })

  it('propagates the typed authentication error to the refresh owner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    vi.mocked(runWithFreshOrcaCloudSession).mockImplementation(
      async (_config, _active, _path, operation) => {
        await expect(operation(session('expired-token'))).rejects.toBeInstanceOf(
          OrcaCloudRequestError
        )
        return { status: 'reconnect-required' }
      }
    )
    expect(await fetchBackofficeFeed(PATH)).toMatchObject({
      ok: false,
      message: expect.stringContaining('HTTP 401')
    })
  })

  it('shows the Inbox gateway explanation of a server failure, bounded', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: 'The hub returned an invalid agent conversation response.' } },
            { status: 502 }
          )
        )
    )
    await expect(fetchBackofficeFeed(PATH)).resolves.toEqual({
      ok: false,
      message: 'The hub returned an invalid agent conversation response. (HTTP 502)'
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 503 })))
    await expect(fetchBackofficeFeed(PATH)).resolves.toEqual({
      ok: false,
      message: 'The backoffice answered HTTP 503.'
    })
  })
})
