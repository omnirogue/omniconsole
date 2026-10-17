import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OmniRogueAccountLease } from './omnirogue-account-lease'
import { TOKEN, json } from '../../shared/room-test-fixtures'

const vault = vi.hoisted(() => ({ payload: null as string | null }))
vi.mock('node:fs', () => ({
  existsSync: () => vault.payload !== null,
  readFileSync: () => vault.payload,
  rmSync: () => {
    vault.payload = null
  }
}))
vi.mock('../../shared/secure-file', () => ({
  writeSecureJsonFile: (_path: string, value: unknown) => {
    vault.payload = JSON.stringify(value)
  }
}))
vi.mock('../../shared/secret-store', () => ({
  getSecretStore: () => ({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (ciphertext: Buffer) => ciphertext.toString()
  })
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/virtual/profile'
}))
vi.mock('../rooms/room-config', () => ({ getRoomConfig: vi.fn() }))

const refreshToken = `or_obr_${'r'.repeat(43)}`
const rotated = `or_obp_${'b'.repeat(43)}`
const config = {
  mode: 'test',
  key: 'test',
  apiOrigin: 'https://api.omnirogue.com',
  frontendOrigin: 'https://omnirogue.com',
  isCurrent: () => true
}
const refreshResponse = () =>
  json({
    access_token: rotated,
    refresh_token: `or_obr_${'s'.repeat(43)}`,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'account:read credits:read credits:spend rooms:read rooms:write'
  })
beforeEach(() => {
  vault.payload = JSON.stringify({
    ciphertext: Buffer.from(
      JSON.stringify({
        token: TOKEN,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
        binding: config.key
      })
    ).toString('base64')
  })
})

describe('account lease requests', () => {
  it('retries a 401 once, and persists the rotated access and refresh token in the vault', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'expired' }, 401))
      .mockResolvedValueOnce(refreshResponse())
      .mockResolvedValueOnce(json({ data: [{ id: 'gpt-future' }] }))
    const options = { resolveConfig: async () => config, fetcher }
    const lease = new OmniRogueAccountLease(options)
    await expect(lease.request('/v1/models')).resolves.toEqual({ data: [{ id: 'gpt-future' }] })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.omnirogue.com/v1/models',
      'https://api.omnirogue.com/api/omniconsole/device/refresh',
      'https://api.omnirogue.com/v1/models'
    ])
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('Authorization')).toBe(
      `Bearer ${rotated}`
    )
    expect(await new OmniRogueAccountLease(options).requireToken()).toBe(rotated)
    const stored = JSON.parse(
      Buffer.from(JSON.parse(vault.payload!).ciphertext, 'base64').toString()
    )
    expect(stored.refreshToken).toBe(`or_obr_${'s'.repeat(43)}`)
    expect(vault.payload).not.toContain(refreshToken)
  })

  it('does not loop if the retried request is still unauthorized', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(refreshResponse())
      .mockResolvedValueOnce(json({}, 401))
    const lease = new OmniRogueAccountLease({ resolveConfig: async () => config, fetcher })
    await expect(lease.request('/v1/models')).rejects.toMatchObject({ code: 'device_unauthorized' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('never sends the device token to another origin', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const lease = new OmniRogueAccountLease({ resolveConfig: async () => config, fetcher })
    await expect(lease.request('https://elsewhere.example/v1/models')).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
