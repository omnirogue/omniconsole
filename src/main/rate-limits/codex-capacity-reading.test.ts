import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchCodexCapacityEntry } from './codex-capacity-reading'
import { discoverExistingAccountDirectories } from './existing-account-directories'
import { fetchCodexRateLimits } from './codex-fetcher'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('node:os', () => ({ homedir: () => '/synthetic' }))
vi.mock('./existing-account-directories', () => ({ discoverExistingAccountDirectories: vi.fn() }))
vi.mock('./codex-fetcher', () => ({ fetchCodexRateLimits: vi.fn() }))
vi.mock('./claude-capacity-reading', () => ({
  emptyReading: () => ({ provider: 'codex', status: 'unavailable', updatedAt: 0, error: null })
}))
vi.mock('./auth-filesystem-operation', () => ({
  createAuthFilesystemOperation: (_path: string, read: () => Promise<unknown>) => {
    const result = read()
    return { result, wait: () => result }
  }
}))
const seat = join('/synthetic', '.codex-second')
const managed = join('/synthetic', 'managed')
const jwt = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.test`
const auth = (refresh: string, access = jwt(Date.now() / 1000 + 3600)) =>
  JSON.stringify({ tokens: { refresh_token: refresh, access_token: access } })
const request = vi.fn()
describe('Codex capacity refresh ownership', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', request)
    request.mockResolvedValue({ ok: true, json: async () => ({ plan_type: 'pro' }) })
    vi.mocked(discoverExistingAccountDirectories).mockReturnValue([
      { provider: 'codex', path: seat }
    ])
    vi.mocked(readFile).mockResolvedValue(auth('shared-synthetic-family'))
  })
  it.each([seat, join('/synthetic', '.codex'), managed])(
    'reads %s without spawning a refresh owner',
    async (path) => {
      expect((await fetchCodexCapacityEntry(path)).status).toBe('ok')
      expect(request).toHaveBeenCalledOnce()
      expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    }
  )
  it.each([jwt(1), '', 'malformed'])(
    'makes no request for unusable access credentials',
    async (access) => {
      vi.mocked(readFile).mockResolvedValue(auth('shared-synthetic-family', access))
      expect((await fetchCodexCapacityEntry(managed)).status).toBe('unavailable')
      expect(request).not.toHaveBeenCalled()
      expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    }
  )
  it('keeps diverged managed refresh families read-only', async () => {
    vi.mocked(readFile).mockImplementation(async (path) =>
      auth(String(path) === join(managed, 'auth.json') ? 'independent' : 'seat-family')
    )
    await fetchCodexCapacityEntry(managed)
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })
  it.each([401, 403])('records backend auth failure %s', async (status) => {
    request.mockResolvedValue({ ok: false, status, body: null })
    expect(await fetchCodexCapacityEntry(managed)).toMatchObject({ status: 'error', error: 'auth' })
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
  })
})
