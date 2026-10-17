import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  RoomCredentialStore,
  ROOM_CALLBACK,
  type RoomCredentialOptions
} from './room-credential-store'
import { roomResult } from './room-error'
import { TOKEN, json } from '../../shared/room-test-fixtures'

function fixture(overrides: Partial<RoomCredentialOptions> = {}) {
  let ciphertext: string | null = null
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    json({
      access_token: TOKEN,
      refresh_token: `or_obr_${'r'.repeat(43)}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'account:read credits:read credits:spend rooms:read rooms:write'
    })
  )
  const options: RoomCredentialOptions = {
    origins: { apiOrigin: 'https://api.example.com', frontendOrigin: 'https://example.com' },
    binding: 'account:origin',
    platform: 'darwin',
    now: () => 10000,
    isCurrent: () => true,
    fetcher,
    openBrowser: vi.fn(async () => undefined),
    secrets: {
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (plain) => Buffer.from(Buffer.from(plain).map((byte) => byte ^ 42)),
      decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 42)).toString()
    },
    vault: {
      read: () => ciphertext,
      write: (value) => {
        ciphertext = value
      },
      clear: () => {
        ciphertext = null
      }
    },
    ...overrides
  }
  const store = new RoomCredentialStore(options)
  const callback = () => {
    const opened = vi.mocked(options.openBrowser).mock.calls.at(-1)![0]
    const url = new URL(opened)
    return `${ROOM_CALLBACK}?state=${url.searchParams.get('state')}&code=${'c'.repeat(43)}`
  }
  return { store, options, fetcher, callback, ciphertext: () => ciphertext }
}
describe('device account credentials', () => {
  it('exchanges PKCE, seals the token, and projects status without secrets', async () => {
    const f = fixture()
    expect(await roomResult(() => f.store.link())).toEqual({ ok: true, data: { state: 'linking' } })
    const opened = new URL(vi.mocked(f.options.openBrowser).mock.calls[0][0])
    expect(opened.origin + opened.pathname).toBe('https://example.com/omniconsole/connect')
    expect(opened.searchParams.get('client_id')).toBe('omniconsole-ide-macos')
    expect(opened.searchParams.get('redirect_uri')).toBe(ROOM_CALLBACK)
    const linked = await roomResult(() => f.store.acceptCallback(f.callback()))
    expect(linked).toEqual({ ok: true, data: { state: 'linked', expiresAt: 3610000 } })
    const [url, init] = f.fetcher.mock.calls[0]
    expect(url).toBe('https://api.example.com/api/omniconsole/device/token')
    const body = JSON.parse(init?.body as string)
    expect(body).toMatchObject({
      client_id: 'omniconsole-ide-macos',
      code: 'c'.repeat(43),
      grant_type: 'authorization_code',
      redirect_uri: ROOM_CALLBACK
    })
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
      opened.searchParams.get('code_challenge')
    )
    expect(new Headers(init?.headers).has('Cookie')).toBe(false)
    expect(new Headers(init?.headers).has('Origin')).toBe(false)
    expect(JSON.stringify(linked)).not.toContain(TOKEN)
    expect(f.ciphertext()).not.toContain(TOKEN)
    expect(
      JSON.parse(f.options.secrets.decryptString(Buffer.from(f.ciphertext()!, 'base64')))
        .refreshToken
    ).toBe(`or_obr_${'r'.repeat(43)}`)
    expect(f.store.access().token).toBe(TOKEN)
    expect(new RoomCredentialStore(f.options).status()).toEqual({
      state: 'linked',
      expiresAt: 3610000
    })
  })
  it.each(['win32', 'linux'] as const)('selects the registered %s client id', async (platform) => {
    const f = fixture({ platform })
    await f.store.link()
    expect(vi.mocked(f.options.openBrowser).mock.calls[0][0]).toContain(
      `client_id=omniconsole-ide-${platform === 'win32' ? 'windows' : 'linux'}`
    )
  })
  it('refuses missing safeStorage and Linux basic_text without writing plaintext', async () => {
    for (const secure of [false, true]) {
      const f = fixture()
      f.options.secrets.isEncryptionAvailable = () => secure
      f.options.secrets.describeProtectionGap = () => 'No keychain'
      await expect(f.store.link()).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
      expect(f.ciphertext()).toBeNull()
      expect(f.options.openBrowser).not.toHaveBeenCalled()
    }
  })
  it('rejects wrong state, duplicate query keys, credentials and replayed callbacks', async () => {
    const f = fixture()
    await f.store.link()
    await expect(f.store.acceptCallback(`${f.callback()}&code=again`)).rejects.toMatchObject({
      code: 'invalid_callback'
    })
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.store.link()
    await expect(
      f.store.acceptCallback(f.callback().replace(/state=[^&]+/, `state=${'z'.repeat(43)}`))
    ).rejects.toMatchObject({ code: 'invalid_callback' })
    await f.store.link()
    const callback = f.callback()
    await f.store.acceptCallback(callback)
    await f.store.acceptCallback(callback)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects wrong scope and expired links', async () => {
    let now = 0
    const f = fixture({ now: () => now })
    await f.store.link()
    now = 600001
    await expect(f.store.acceptCallback(f.callback())).rejects.toMatchObject({
      code: 'link_expired'
    })
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.store.link()
    f.fetcher.mockResolvedValue(
      json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'account:read' })
    )
    await expect(f.store.acceptCallback(f.callback())).rejects.toMatchObject({
      code: 'invalid_response'
    })
    expect(f.ciphertext()).toBeNull()
  })
  it('fences in-flight leases on unlink and requires successful remote revocation', async () => {
    const f = fixture()
    await f.store.link()
    await f.store.acceptCallback(f.callback())
    const lease = f.store.access()
    f.fetcher.mockResolvedValue(json({ error: 'unavailable' }, 503))
    await expect(f.store.unlink()).rejects.toMatchObject({ code: 'rooms_unavailable' })
    expect(() => lease.check()).toThrow()
    expect(f.store.status().state).toBe('linked')
    f.fetcher.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await f.store.unlink()).toEqual({ state: 'unlinked' })
    expect(f.ciphertext()).toBeNull()
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe(
      'https://api.example.com/api/omniconsole/device/revoke'
    )
  })
  it('never restores credentials under another account or origin binding', async () => {
    const f = fixture()
    await f.store.link()
    await f.store.acceptCallback(f.callback())
    expect(new RoomCredentialStore({ ...f.options, binding: 'another' }).status()).toEqual({
      state: 'unlinked'
    })
    f.options.isCurrent = () => false
    expect(() => f.store.access()).toThrow()
  })
  it('discards and revokes a token when unlink wins the code-exchange race', async () => {
    const f = fixture()
    await f.store.link()
    let resolve!: (response: Response) => void
    f.fetcher
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const exchange = f.store.acceptCallback(f.callback())
    const rejected = expect(exchange).rejects.toMatchObject({ code: 'connection_changed' })
    await f.store.unlink()
    resolve(
      json({
        access_token: TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'account:read credits:read credits:spend rooms:read rooms:write'
      })
    )
    await rejected
    expect(f.ciphertext()).toBeNull()
    expect(f.store.status().state).toBe('unlinked')
  })
})
