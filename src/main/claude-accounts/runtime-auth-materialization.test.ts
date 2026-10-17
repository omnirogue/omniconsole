import type * as NodeOs from 'node:os'
import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSeatDirectories } from '../rate-limits/claude-seat-directory'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../rate-limits/claude-seat-directory', () => ({
  hasClaudeSeatForManagedPath: vi.fn(() => false),
  claudeSeatDirectories: vi.fn(() => []),
  sameClaudeIdentity: (a: { email: string }, b: { email: string }) => a.email === b.email
}))

describe('runtime auth materialization guard', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    vi.mocked(claudeSeatDirectories).mockReturnValue([])
  })
  afterEach(() => cleanupRuntimeAuthTestState())
  it.each(['expired', 'seat'] as const)(
    'does not materialize %s-owned credentials',
    async (reason) => {
      const credentials = createClaudeCredentialsJson(
        'user@example.com',
        'synthetic',
        null,
        reason === 'expired' ? 1 : Date.now() + 3_600_000
      )
      const path = createManagedClaudeAuth(testState.userDataDir, 'a', credentials)
      const settings = createSettings({
        claudeManagedAccounts: [createClaudeAccount('a', path, { email: 'user@example.com' })]
      })
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      const service = new ClaudeRuntimeAuthService(createStore(settings) as never)
      if (reason === 'seat') {
        vi.mocked(claudeSeatDirectories).mockReturnValue([
          { provider: 'claude', path: '/synthetic/seat', email: 'user@example.com' }
        ])
      }
      settings.activeClaudeManagedAccountId = 'a'
      await service.syncForCurrentSelection()
      expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
      expect(testState.runtimeWriteConfigDir).toBeNull()
    }
  )
})
