import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAccountSyncPrefs, writeAccountSyncPref } from './backoffice-account-sync'

vi.mock('./backoffice-config', () => ({
  getBackofficeSnapshot: () => ({ configured: true, baseUrl: 'https://omnios.test', message: '' })
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: true, config: {} })
}))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: async (
    _config: unknown,
    _active: unknown,
    _path: unknown,
    run: (session: { accessToken: string }) => Promise<unknown>
  ) => ({ status: 'ok', value: await run({ accessToken: 'desktop-token' }) })
}))
vi.mock('../omni-profiles/profile-cloud-client', () => ({
  OrcaCloudRequestError: class extends Error {}
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('account sync client', () => {
  it('reads only this app’s documents, as the signed-in person', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        user: 'user_sal',
        prefs: {
          'omni-ide.sync.folders': { value: { v: 1, f: {} }, updated_at: 'x' },
          'gtd.perspectives': { value: ['mine'], updated_at: 'x' }
        }
      })
    )
    vi.stubGlobal('fetch', fetch)
    await expect(readAccountSyncPrefs()).resolves.toEqual({
      ok: true,
      user: 'user_sal',
      prefs: { 'omni-ide.sync.folders': { v: 1, f: {} } }
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://omnios.test/api/gtd/prefs')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-token')
  })

  it('writes only its own keys, within omnios’ size, and names a changed account', async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal('fetch', fetch)
    await expect(
      writeAccountSyncPref({ key: 'gtd.perspectives', value: 1, expectedUser: 'u' })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      writeAccountSyncPref({
        key: 'omni-ide.sync.sessions.1',
        value: 'x'.repeat(40_000),
        expectedUser: 'u'
      })
    ).resolves.toMatchObject({ ok: false, message: 'A session sync document is at most 32 KB.' })
    // omnios measures Python's escaped JSON: 6 characters for each of these.
    await expect(
      writeAccountSyncPref({
        key: 'omni-ide.sync.sessions.1',
        value: '文'.repeat(6_000),
        expectedUser: 'u'
      })
    ).resolves.toMatchObject({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
    await expect(
      writeAccountSyncPref({ key: 'omni-ide.sync.sessions.1', value: { v: 1 }, expectedUser: 'u' })
    ).resolves.toEqual({ ok: true })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://omnios.test/api/gtd/prefs/omni-ide.sync.sessions.1')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ value: { v: 1 }, expected_user: 'u' })
    fetch.mockResolvedValueOnce(json(409, { error: { code: 'account_changed' } }))
    await expect(
      writeAccountSyncPref({ key: 'omni-ide.sync.folders', value: {}, expectedUser: 'u' })
    ).resolves.toMatchObject({ ok: false, accountChanged: true })
  })
})
