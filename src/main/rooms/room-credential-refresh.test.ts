import { describe, expect, it, vi } from 'vitest'
import { RoomCredentialStore, type RoomCredentialOptions } from './room-credential-store'
import { TOKEN, json } from '../../shared/room-test-fixtures'

const REFRESH = `or_obr_${'r'.repeat(43)}`
const ROTATED = `or_obp_${'b'.repeat(43)}`
const NEXT_REFRESH = `or_obr_${'s'.repeat(43)}`
const response = () =>
  json({
    access_token: ROTATED,
    refresh_token: NEXT_REFRESH,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'account:read credits:read credits:spend rooms:read rooms:write'
  })

function fixture(expiresAt = 600_000, refreshToken: string | undefined = REFRESH) {
  let now = 0
  let ciphertext: string | null = Buffer.from(
    JSON.stringify({
      token: TOKEN,
      refreshToken,
      expiresAt,
      binding: 'test'
    })
  ).toString('base64')
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())
  const options: RoomCredentialOptions = {
    binding: 'test',
    platform: 'darwin',
    isCurrent: () => true,
    now: () => now,
    origins: { apiOrigin: 'https://api.example.com', frontendOrigin: 'https://example.com' },
    openBrowser: async () => {},
    fetcher,
    secrets: {
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: (encrypted) => encrypted.toString()
    },
    vault: {
      read: () => ciphertext,
      write: (value) => {
        ciphertext = value
      },
      clear: () => {
        ciphertext = null
      }
    }
  }
  return {
    store: new RoomCredentialStore(options),
    options,
    fetcher,
    time: (value: number) => {
      now = value
    },
    ciphertext: () => ciphertext
  }
}

describe('device refresh credentials', () => {
  it('refreshes at the five-minute boundary and persists both rotated tokens across restart', async () => {
    const f = fixture()
    f.time(299_999)
    expect((await f.store.leaseAccess()).token).toBe(TOKEN)
    expect(f.fetcher).not.toHaveBeenCalled()
    f.time(300_000)
    expect((await f.store.leaseAccess()).token).toBe(ROTATED)
    const [url, init] = f.fetcher.mock.calls[0]
    expect(url).toBe('https://api.example.com/api/omniconsole/device/refresh')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toMatchObject({ refresh_token: REFRESH })
    const restarted = new RoomCredentialStore(f.options)
    expect((await restarted.leaseAccess()).token).toBe(ROTATED)
    await restarted.leaseAccess(ROTATED)
    expect(JSON.parse(f.fetcher.mock.calls[1][1]?.body as string).refresh_token).toBe(NEXT_REFRESH)
    expect(JSON.stringify(restarted.status())).not.toContain('or_ob')
  })

  it('refreshes expired access tokens and shares simultaneous refresh requests', async () => {
    const f = fixture(0)
    const accesses = await Promise.all([
      f.store.leaseAccess(),
      f.store.leaseAccess(),
      f.store.leaseAccess()
    ])
    expect(accesses.map((access) => access.token)).toEqual([ROTATED, ROTATED, ROTATED])
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it('forces refresh after a 401 but reuses a rotation completed by another caller', async () => {
    const f = fixture()
    await f.store.leaseAccess(TOKEN)
    expect((await f.store.leaseAccess(TOKEN)).token).toBe(ROTATED)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains credentials on refresh failure without handing out an expired token', async () => {
    const f = fixture(0)
    const before = f.ciphertext()
    f.fetcher.mockResolvedValue(json({ error: 'unavailable' }, 503))
    await expect(f.store.leaseAccess()).rejects.toMatchObject({ code: 'rooms_unavailable' })
    expect(f.ciphertext()).toBe(before)
  })

  it('supports legacy credentials without a refresh token until expiry', async () => {
    const f = fixture()
    f.options.vault.read = () =>
      Buffer.from(JSON.stringify({ token: TOKEN, expiresAt: 600_000, binding: 'test' })).toString(
        'base64'
      )
    expect((await f.store.leaseAccess()).token).toBe(TOKEN)
    f.time(600_000)
    await expect(f.store.leaseAccess()).rejects.toMatchObject({ code: 'device_unauthorized' })
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('does not restore a credential when unlink wins an in-flight refresh', async () => {
    const f = fixture(0)
    let resolve!: (value: Response) => void
    f.fetcher
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const refreshing = f.store.leaseAccess()
    const rejected = expect(refreshing).rejects.toMatchObject({ code: 'connection_changed' })
    await f.store.unlink()
    resolve(response())
    await rejected
    expect(f.ciphertext()).toBeNull()
    expect(f.store.status().state).toBe('unlinked')
  })
})
