import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeCapacityEntry, type CapacityEntry } from './claude-capacity-reading'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { AccountCapacityReadings } from './account-capacity-readings'
import type { ClaudeWorkingSource } from './claude-working-source'
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: vi.fn() }))
vi.mock('./claude-working-source', () => ({
  rejectClaudeSource: vi.fn(),
  isRejectedClaudeSource: () => false
}))
const cache = { get: vi.fn(() => null) } as unknown as AccountCapacityReadings
function source(path: string, expired = false): ClaudeWorkingSource {
  return {
    kind: 'seat',
    path,
    accessUsable: !expired,
    refreshUsable: true,
    expired,
    read: vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: path,
          refreshToken: 'synthetic-only',
          expiresAt: expired ? 1 : Date.now() + 60_000
        }
      })
    )
  }
}
function entry(sources: ClaudeWorkingSource[]): CapacityEntry {
  return {
    accountId: 'a',
    email: 'synthetic@example.test',
    path: sources[0].path,
    launchEnv: { CLAUDE_CONFIG_DIR: sources[0].path },
    sources
  }
}
describe('Claude capacity source reading', () => {
  beforeEach(() => vi.clearAllMocks())
  it('tries the next seat after a 401 without refreshing or writing either seat', async () => {
    vi.mocked(fetchClaudeOAuthUsage)
      .mockRejectedValueOnce(new OAuthUsageError('revoked', 401, true))
      .mockResolvedValueOnce({
        provider: 'claude',
        session: null,
        weekly: null,
        status: 'ok',
        error: null,
        updatedAt: 10
      })
    const row = entry([source('/first'), source('/second')])
    expect((await fetchClaudeCapacityEntry(row, cache)).status).toBe('ok')
    expect(row.launchEnv).toEqual({ CLAUDE_CONFIG_DIR: '/second' })
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(2)
  })
  it('leaves an expired access token to the seat CLI and never calls the usage endpoint', async () => {
    const row = entry([source('/expired', true)])
    await fetchClaudeCapacityEntry(row, cache)
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
    expect(row.launchEnv).not.toBeNull()
  })
  it('records Retry-After without declaring exhausted quota or signing out', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(
      new OAuthUsageError('throttled', 429, true, 60_000)
    )
    const row = entry([source('/throttled')])
    const result = await fetchClaudeCapacityEntry(row, cache)
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now() + 59_000)
    expect(result.session).toBeNull()
    expect(row.launchEnv).not.toBeNull()
  })
  it('keeps a missing-scope login launchable without usage windows', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(
      new OAuthUsageError('missing user:profile scope', 403, true)
    )
    const row = entry([source('/missing-scope')])
    expect((await fetchClaudeCapacityEntry(row, cache)).session).toBeNull()
    expect(row.launchEnv).toEqual({ CLAUDE_CONFIG_DIR: '/missing-scope' })
    expect(row.signedOutReason).toBeUndefined()
  })
  it('does not probe during a persisted pause, including manual refreshes', async () => {
    const paused = { provider: 'claude', usageMetadata: { retryAtMs: Date.now() + 60_000 } }
    const readingCache = { get: () => paused } as unknown as AccountCapacityReadings
    expect(await fetchClaudeCapacityEntry(entry([source('/paused')]), readingCache)).toBe(paused)
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })
})

it('retains launch state on a transient credential read failure', async () => {
  const candidate = source('/locked')
  vi.mocked(candidate.read).mockRejectedValueOnce(new Error('locked'))
  const row = entry([candidate])
  expect((await fetchClaudeCapacityEntry(row, cache)).usageMetadata?.failureKind).toBe('network')
  expect(row.launchEnv).toEqual({ CLAUDE_CONFIG_DIR: '/locked' })
  expect(row.signedOutReason).toBeUndefined()
})
