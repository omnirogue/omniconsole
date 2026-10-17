import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type * as ClaudeLivePtyGate from '../claude-accounts/live-pty-gate'
import { rejectClaudeSource, resolveClaudeWorkingSources } from './claude-working-source'
import { claudeSeatDirectories, readClaudeSeatCredentials } from './claude-seat-directory'
import {
  confirmSeededClaudeLivePtys,
  hasLiveClaudePtysForConfigDir,
  markClaudePtyExited,
  markClaudePtySpawned,
  seedLiveClaudePtysFromPersistence
} from '../claude-accounts/live-pty-gate'
import { readClaudeAccountSessionCredentials } from '../claude-accounts/account-session-credentials'
import {
  refreshClaudeAccountSessionIfIdle,
  refreshClaudeManagedAccountIfIdle
} from '../claude-accounts/account-session-refresh'
import { refreshClaudeOauthCredentials } from '../claude-accounts/oauth-refresh'
import { readClaudeManagedCredentialsJson } from './claude-managed-account-credentials'

vi.mock('./claude-seat-directory', () => ({
  claudeSeatDirectories: vi.fn(() => []),
  sameClaudeIdentity: (a: { email: string }, b: { email: string }) => a.email === b.email,
  readClaudeSeatCredentials: vi.fn(async () => null)
}))
vi.mock('../claude-accounts/account-session-credentials', () => ({
  readClaudeAccountSessionCredentials: vi.fn()
}))
vi.mock('../claude-accounts/account-session-refresh', () => ({
  refreshClaudeAccountSessionIfIdle: vi.fn(),
  refreshClaudeManagedAccountIfIdle: vi.fn()
}))
vi.mock('../claude-accounts/live-pty-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeLivePtyGate>()
  return { ...actual, hasLiveClaudePtysForConfigDir: vi.fn(actual.hasLiveClaudePtysForConfigDir) }
})
vi.mock('../claude-accounts/oauth-refresh', () => ({ refreshClaudeOauthCredentials: vi.fn() }))
vi.mock('./claude-managed-account-credentials', () => ({
  resolveClaudeManagedCredentialsLocation: () => ({
    kind: 'file',
    managedAuthPath: '/synthetic/auth'
  }),
  readClaudeManagedCredentialsJson: vi.fn(),
  writeClaudeManagedCredentialsJson: vi.fn()
}))
const account = { id: 'a', email: 'a@example.test', lastAuthenticatedAt: 1 } as ClaudeManagedAccount
const expired = JSON.stringify({
  claudeAiOauth: { accessToken: 'synthetic', refreshToken: 'rotated', expiresAt: 1 }
})

describe('working-source refresh ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(claudeSeatDirectories).mockReturnValue([])
    vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(expired)
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(expired)
    vi.mocked(refreshClaudeAccountSessionIfIdle).mockResolvedValue('synthetic-refreshed')
  })
  it('refreshes the session and its mirror instead of the superseded managed token', async () => {
    const sources = await resolveClaudeWorkingSources(account)
    expect(sources[0].kind).toBe('session')
    expect(await sources[0].refresh?.()).toBe('synthetic-refreshed')
    expect(refreshClaudeAccountSessionIfIdle).toHaveBeenCalledWith('a', '/synthetic/auth', 1)
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
    expect(readClaudeManagedCredentialsJson).toHaveBeenCalledTimes(1)
  })
  it('rechecks seat ownership immediately before either managed or session refresh', async () => {
    const sources = await resolveClaudeWorkingSources(account)
    vi.mocked(claudeSeatDirectories).mockReturnValue([
      { provider: 'claude', path: '/seat', email: account.email }
    ])
    for (const source of sources) {
      expect(await source.refresh?.()).toBeNull()
    }
    expect(refreshClaudeAccountSessionIfIdle).not.toHaveBeenCalled()
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })
  it('defers refresh while a live CLI may own the session directory', async () => {
    const sources = await resolveClaudeWorkingSources(account)
    vi.mocked(hasLiveClaudePtysForConfigDir).mockReturnValue(true)
    for (const source of sources) {
      expect(await source.refresh?.()).toBeNull()
    }
    expect(refreshClaudeAccountSessionIfIdle).not.toHaveBeenCalled()
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })
  it('does not promote valid managed copies when the matching seat was rejected', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'synthetic', expiresAt: Date.now() + 60_000 }
    })
    vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(raw)
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(raw)
    vi.mocked(readClaudeSeatCredentials).mockResolvedValue(raw)
    rejectClaudeSource(
      {
        kind: 'seat',
        path: '/rejected-seat',
        accessUsable: true,
        refreshUsable: false,
        expired: false,
        read: async () => raw
      },
      raw
    )
    expect(
      await resolveClaudeWorkingSources(account, [
        { provider: 'claude', path: '/rejected-seat', email: account.email }
      ])
    ).toEqual([])
  })
  it('keeps background refresh disabled when a matching empty profile exists', async () => {
    const sources = await resolveClaudeWorkingSources(account, [
      { provider: 'claude', path: '/seat', email: account.email }
    ])
    expect(sources.map((source) => source.kind)).toEqual(['session'])
    expect(sources.every((source) => source.refresh === undefined)).toBe(true)
    expect(refreshClaudeManagedAccountIfIdle).not.toHaveBeenCalled()
  })
  it('uses a fresh managed login when matching profiles have no usable credentials', async () => {
    vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(null)
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'new-login', expiresAt: Date.now() + 60_000 }
      })
    )
    vi.mocked(readClaudeSeatCredentials).mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: 0 } })
    )
    const sources = await resolveClaudeWorkingSources(account, [
      { provider: 'claude', path: '/empty-seat', email: account.email },
      { provider: 'claude', path: '/.claude-accounts/account/slot-1', email: account.email }
    ])
    expect(sources.map((source) => source.kind)).toEqual(['managed'])
    expect(sources[0].accessUsable).toBe(true)
    expect(sources[0].refresh).toBeUndefined()
  })
  it('keeps usable profiles ahead of a fresh managed login', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'usable', expiresAt: Date.now() + 60_000 }
    })
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(raw)
    vi.mocked(readClaudeSeatCredentials).mockResolvedValue(raw)
    const sources = await resolveClaudeWorkingSources(account, [
      { provider: 'claude', path: '/working-seat', email: account.email }
    ])
    expect(sources.map((source) => source.path)).toEqual(['/working-seat'])
  })
  it.each(['unattributed', 'different-profile'])(
    'shows a saved login with a %s session without enabling background refresh',
    async (owner) => {
      seedLiveClaudePtysFromPersistence(['restored-unknown'])
      confirmSeededClaudeLivePtys(['restored-unknown'])
      if (owner === 'different-profile') {
        markClaudePtySpawned('restored-unknown', '/other-account')
      }
      vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(null)
      vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'new-login', expiresAt: Date.now() + 60_000 }
        })
      )
      try {
        const sources = await resolveClaudeWorkingSources(account, [
          { provider: 'claude', path: '/empty-profile', email: account.email }
        ])
        expect(sources.map((source) => source.kind)).toEqual(['managed'])
        expect(sources[0].refresh).toBeUndefined()
        expect(hasLiveClaudePtysForConfigDir('/empty-profile')).toBe(owner === 'unattributed')
        expect(refreshClaudeManagedAccountIfIdle).not.toHaveBeenCalled()
        expect(refreshClaudeAccountSessionIfIdle).not.toHaveBeenCalled()
      } finally {
        markClaudePtyExited('restored-unknown')
      }
    }
  )
  it('does not replace credentials owned by a live profile even when its stored tokens are empty', async () => {
    vi.mocked(hasLiveClaudePtysForConfigDir).mockReturnValue(true)
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'new-login', expiresAt: Date.now() + 60_000 }
      })
    )
    expect(
      await resolveClaudeWorkingSources(account, [
        { provider: 'claude', path: '/live-seat', email: account.email }
      ])
    ).toEqual([])
  })
  it('does not treat a failed profile credential read as an empty profile', async () => {
    vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'new-login', expiresAt: Date.now() + 60_000 }
      })
    )
    vi.mocked(readClaudeSeatCredentials).mockRejectedValue(new Error('locked'))
    await expect(
      resolveClaudeWorkingSources(account, [
        { provider: 'claude', path: '/locked-seat', email: account.email }
      ])
    ).rejects.toThrow('temporarily unavailable')
  })
})

it('does not offer a refresh-only managed mirror without a session', async () => {
  vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(null)
  vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(expired)
  expect(await resolveClaudeWorkingSources(account, [])).toEqual([])
})
it('promotes a refresh-only managed mirror to launchable after a successful guarded refresh', async () => {
  const refreshed = JSON.stringify({
    claudeAiOauth: { accessToken: 'fresh', refreshToken: 'rotated', expiresAt: Date.now() + 60_000 }
  })
  vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(null)
  vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(expired)
  vi.mocked(refreshClaudeManagedAccountIfIdle).mockResolvedValue(refreshed)
  const sources = await resolveClaudeWorkingSources(account, [])
  expect(sources).toHaveLength(1)
  expect(sources[0].kind).toBe('managed')
  expect(sources[0].accessUsable).toBe(true)
  expect(refreshClaudeManagedAccountIfIdle).toHaveBeenCalledWith(account)
})
it('leaves a refresh-only managed mirror non-launchable when the guarded refresh fails', async () => {
  vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue(null)
  vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue(expired)
  vi.mocked(refreshClaudeManagedAccountIfIdle).mockResolvedValue(null)
  expect(await resolveClaudeWorkingSources(account, [])).toEqual([])
})
it('distinguishes failed probes from absent credentials', async () => {
  vi.mocked(readClaudeAccountSessionCredentials).mockRejectedValue(new Error('locked'))
  vi.mocked(readClaudeManagedCredentialsJson).mockRejectedValue(new Error('timeout'))
  await expect(resolveClaudeWorkingSources(account, [])).rejects.toThrow('temporarily unavailable')
})
