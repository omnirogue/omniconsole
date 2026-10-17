import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  readClaudeManagedCredentialsJson,
  writeClaudeManagedCredentialsJson
} from '../rate-limits/claude-managed-account-credentials'
import { hasClaudeSeatForManagedPath } from '../rate-limits/claude-seat-directory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refreshClaudeAccountSessionIfIdle,
  refreshClaudeManagedAccountIfIdle,
  withClaudeAccountMutation
} from './account-session-refresh'
import {
  readClaudeAccountSessionCredentials,
  writeClaudeAccountSessionCredentials
} from './account-session-credentials'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import { writeClaudeManagedAuthFile } from './managed-auth-path'
import {
  beginClaudeAuthSwitch,
  endClaudeAuthSwitch,
  markClaudePtySpawned,
  markClaudePtyExited,
  isClaudeAuthSwitchInProgress
} from './live-pty-gate'

vi.mock('../rate-limits/claude-seat-directory', () => ({
  hasClaudeSeatForManagedPath: vi.fn(() => false),
  claudeSeatDirectories: vi.fn(() => []),
  sameClaudeIdentity: vi.fn(() => false)
}))
vi.mock('./account-session-credentials', () => ({
  readClaudeAccountSessionCredentials: vi.fn(),
  writeClaudeAccountSessionCredentials: vi.fn()
}))
vi.mock('./managed-auth-path', () => ({
  resolveOwnedClaudeManagedAuthPath: (_id: string, path: string) => path,
  writeClaudeManagedAuthFile: vi.fn()
}))
vi.mock('./keychain', () => ({ writeManagedClaudeKeychainCredentials: vi.fn() }))
vi.mock('./oauth-refresh', () => ({
  isOauthTokenExpiring: vi.fn(),
  refreshClaudeOauthCredentials: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.mocked(readClaudeAccountSessionCredentials).mockResolvedValue('expired')
  vi.mocked(writeClaudeAccountSessionCredentials).mockResolvedValue(undefined)
  vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
  vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue('refreshed')
})
afterEach(() => {
  markClaudePtyExited('live-test')
  vi.restoreAllMocks()
})

describe('parked Claude session refresh', () => {
  it('never refreshes or writes a managed copy when a same-identity seat exists', async () => {
    vi.mocked(hasClaudeSeatForManagedPath).mockReturnValueOnce(true)
    expect(await refreshClaudeAccountSessionIfIdle('account', '/auth')).toBe('expired')
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
    expect(writeClaudeAccountSessionCredentials).not.toHaveBeenCalled()
    expect(writeClaudeManagedAuthFile).not.toHaveBeenCalled()
  })
  it('coalesces requests and updates both credential copies before admitting launches', async () => {
    vi.mocked(refreshClaudeOauthCredentials).mockImplementation(async () => {
      expect(isClaudeAuthSwitchInProgress()).toBe(true)
      return 'refreshed'
    })
    const first = refreshClaudeAccountSessionIfIdle('a', '/a', 1)
    expect(refreshClaudeAccountSessionIfIdle('a', '/a', 1)).toBe(first)
    expect(await first).toBe('refreshed')
    expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
    expect(writeClaudeAccountSessionCredentials).toHaveBeenCalledWith('a', '/a', 'refreshed', 1)
    expect(writeClaudeManagedAuthFile).toHaveBeenCalledWith('/a', '.credentials.json', 'refreshed')
    expect(isClaudeAuthSwitchInProgress()).toBe(false)
  })
  it('finishes an existing refresh before a manual sign-in writes and defers new refreshes', async () => {
    let finishRefresh!: (value: string) => void
    const refreshing = new Promise<string>((resolve) => {
      finishRefresh = resolve
    })
    vi.mocked(refreshClaudeOauthCredentials).mockReturnValueOnce(refreshing)
    const first = refreshClaudeAccountSessionIfIdle('a', '/a', 1)
    await vi.waitFor(() => expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce())
    let finishSignIn!: () => void
    const signingIn = new Promise<void>((resolve) => {
      finishSignIn = resolve
    })
    const writeNewSignIn = vi.fn(() => signingIn)
    const mutation = withClaudeAccountMutation(writeNewSignIn)
    expect(writeNewSignIn).not.toHaveBeenCalled()
    finishRefresh('refreshed')
    await first
    await vi.waitFor(() => expect(writeNewSignIn).toHaveBeenCalledOnce())
    expect(await refreshClaudeAccountSessionIfIdle('b', '/b', 1)).toBe('expired')
    expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
    finishSignIn()
    await mutation
    expect(await refreshClaudeAccountSessionIfIdle('b', '/b', 1)).toBe('refreshed')
    expect(refreshClaudeOauthCredentials).toHaveBeenCalledTimes(2)
  })

  it('does not rotate credentials owned by a live CLI', async () => {
    markClaudePtySpawned('live-test', '/a/session')
    expect(await refreshClaudeAccountSessionIfIdle('a', '/a', 1)).toBe('expired')
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })
  it('can refresh a parked account while a different known account runs', async () => {
    markClaudePtySpawned('live-test', '/b/session')
    expect(await refreshClaudeAccountSessionIfIdle('a', '/a', 1)).toBe('refreshed')
  })
  it('defers when a surviving CLI has an unknown account directory', async () => {
    markClaudePtySpawned('live-test')
    expect(await refreshClaudeAccountSessionIfIdle('a', '/a', 1)).toBe('expired')
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })
  it('releases launch admission after failed persistence', async () => {
    vi.mocked(writeClaudeAccountSessionCredentials).mockRejectedValueOnce(new Error('locked'))
    await expect(refreshClaudeAccountSessionIfIdle('a', '/a', 1)).rejects.toThrow('locked')
    expect(isClaudeAuthSwitchInProgress()).toBe(false)
    expect(writeClaudeManagedAuthFile).not.toHaveBeenCalled()
  })
})

vi.mock('../rate-limits/claude-managed-account-credentials', () => ({
  resolveClaudeManagedCredentialsLocation: () => ({
    kind: 'file',
    managedAuthPath: '/synthetic/auth'
  }),
  readClaudeManagedCredentialsJson: vi.fn(),
  writeClaudeManagedCredentialsJson: vi.fn()
}))
const managedAccount = {
  id: 'managed',
  managedAuthPath: '/synthetic/auth',
  lastAuthenticatedAt: 1
} as ClaudeManagedAccount
it('serializes managed refreshes and discards rotations if the source changed', async () => {
  vi.mocked(readClaudeManagedCredentialsJson)
    .mockResolvedValueOnce('old')
    .mockResolvedValueOnce('new-login')
  vi.mocked(refreshClaudeOauthCredentials).mockImplementation(async () => {
    expect(isClaudeAuthSwitchInProgress()).toBe(true)
    return 'rotated'
  })
  const first = refreshClaudeManagedAccountIfIdle(managedAccount)
  expect(refreshClaudeManagedAccountIfIdle(managedAccount)).toBe(first)
  expect(await first).toBeNull()
  expect(writeClaudeManagedCredentialsJson).not.toHaveBeenCalled()
  expect(isClaudeAuthSwitchInProgress()).toBe(false)
})
it('does not refresh managed credentials during a manual mutation', async () => {
  await withClaudeAccountMutation(async () => {
    expect(await refreshClaudeManagedAccountIfIdle(managedAccount)).toBeNull()
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })
})

it('refreshes for the mutation owner without releasing the outer switch gate', async () => {
  vi.mocked(readClaudeManagedCredentialsJson).mockResolvedValue('old')
  vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue('rotated')
  await withClaudeAccountMutation(async () => {
    beginClaudeAuthSwitch()
    try {
      expect(
        await refreshClaudeManagedAccountIfIdle(managedAccount, { ownerHoldsMutation: true })
      ).toBe('rotated')
      expect(isClaudeAuthSwitchInProgress()).toBe(true)
      expect(writeClaudeManagedCredentialsJson).toHaveBeenCalledWith(expect.anything(), 'rotated')
    } finally {
      endClaudeAuthSwitch()
    }
  })
})
