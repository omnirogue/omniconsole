import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { childSpawnMock, ptySpawnMock, readFileMock, startBackfillRecoveryMock } = vi.hoisted(
  () => ({
    childSpawnMock: vi.fn(),
    ptySpawnMock: vi.fn(),
    readFileMock: vi.fn(),
    startBackfillRecoveryMock: vi.fn(() => Promise.resolve(null))
  })
)
vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: () => true }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: startBackfillRecoveryMock
}))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: () => 'present' }))
import { fetchCodexRateLimits } from './codex-fetcher'
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())
it('reads backend allowance during indexing without spawning a competing quota probe', async () => {
  readFileMock.mockResolvedValue(
    JSON.stringify({ tokens: { access_token: 'access-token', account_id: 'account-id' } })
  )
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1800000000 }
      }
    })
  } as Response)
  await expect(
    fetchCodexRateLimits({ codexHomePath: '/managed-home', allowPtyFallback: false })
  ).resolves.toMatchObject({
    status: 'ok',
    session: { usedPercent: 7 }
  })
  expect(startBackfillRecoveryMock).toHaveBeenCalledWith('/managed-home')
  expect(childSpawnMock).not.toHaveBeenCalled()
  expect(ptySpawnMock).not.toHaveBeenCalled()
})
