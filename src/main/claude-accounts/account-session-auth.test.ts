import { rejectClaudeSource } from '../rate-limits/claude-working-source'
import { claudeCredentialHealth } from '../rate-limits/claude-credential-health'
import {
  claudeSeatDirectories,
  readClaudeSeatCredentials
} from '../rate-limits/claude-seat-directory'
import {
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials
} from './keychain'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  prepareClaudeAccountSession,
  readClaudeAccountSessionCredentials
} from './account-session-auth'
import { resolveOwnedClaudeManagedAuthPath, readClaudeManagedAuthFile } from './managed-auth-path'
import { shareDefaultSessionRegistry } from './account-session-registry'
import {
  confirmSeededClaudeLivePtys,
  markClaudePtyExited,
  seedLiveClaudePtysFromPersistence
} from './live-pty-gate'

vi.mock('./managed-auth-path', () => ({
  resolveOwnedClaudeManagedAuthPath: vi.fn(),
  readClaudeManagedAuthFile: vi.fn()
}))
vi.mock('./account-directory-hooks', () => ({ ensureClaudeHooksForRequestedEnv: vi.fn() }))
vi.mock('./account-session-registry', () => ({ shareDefaultSessionRegistry: vi.fn() }))
vi.mock('./keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn()
}))
vi.mock('../codex-accounts/fs-utils', () => ({
  writeFileAtomically: (path: string, contents: string) =>
    writeFileSync(path, contents, { mode: 0o600 })
}))

vi.mock('../rate-limits/claude-seat-directory', () => ({
  hasClaudeSeatForManagedPath: vi.fn(() => false),
  claudeSeatDirectories: vi.fn(() => []),
  readClaudeSeatCredentials: vi.fn(),
  sameClaudeIdentity: () => true
}))
const credential = (value: string, expiresAt = 9_000_000_000_000) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: value, refreshToken: `${value}-refresh`, expiresAt }
  })
const roots: string[] = []
beforeEach(() => {
  vi.mocked(claudeSeatDirectories).mockReturnValue([])
  vi.mocked(readClaudeSeatCredentials).mockResolvedValue(credential('working-seat'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.mocked(resolveOwnedClaudeManagedAuthPath).mockImplementation((_id, path) => path)
  vi.mocked(readClaudeManagedAuthFile).mockImplementation((path, name) =>
    readFileSync(join(path, name), 'utf8')
  )
})
afterEach(() => {
  markClaudePtyExited('restored-unknown')
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  // Why: these keychain/managed-auth mocks are plain vi.fn()s from a factory
  // vi.mock, not vi.spyOn spies -- restoreAllMocks() only restores spies, so a
  // prior test's call history (and any lingering asymmetric mockResolvedValue)
  // otherwise leaks into the next test's `.not.toHaveBeenCalled()` assertions.
  vi.clearAllMocks()
  vi.restoreAllMocks()
})
function account(id: string): ClaudeManagedAccount {
  const path = mkdtempSync(join(tmpdir(), 'claude-session-auth-'))
  roots.push(path)
  writeFileSync(join(path, '.credentials.json'), credential(`${id}-credential`))
  writeFileSync(
    join(path, 'oauth-account.json'),
    JSON.stringify({ emailAddress: `${id}@example.com` })
  )
  return { id, managedAuthPath: path, lastAuthenticatedAt: 1 } as ClaudeManagedAccount
}

describe('per-account Claude session authentication', () => {
  it('uses only the selected account scoped Keychain on macOS and retains CLI refreshes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const a = account('mac-a')
    const sessionPath = join(a.managedAuthPath, 'session')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue(credential('managed-token'))
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(null)
    vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue(undefined)
    await prepareClaudeAccountSession(a)
    expect(writeActiveClaudeKeychainCredentials).toHaveBeenCalledExactlyOnceWith(
      credential('managed-token'),
      sessionPath
    )
    expect(shareDefaultSessionRegistry).toHaveBeenCalledWith(sessionPath)
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      credential('cli-refreshed-token')
    )
    await prepareClaudeAccountSession(a)
    expect(writeActiveClaudeKeychainCredentials).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(sessionPath)
    expect(await readClaudeAccountSessionCredentials(a.id, a.managedAuthPath, 1)).toBe(
      credential('cli-refreshed-token')
    )
  })

  it('routes to a seat appearing immediately before seeding, even when preserving the session', async () => {
    const a = account('race')
    const seatPath = join(a.managedAuthPath, 'seat')
    vi.mocked(claudeSeatDirectories)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([{ provider: 'claude', path: seatPath }])
    const result = await prepareClaudeAccountSession(a, { preserveSessionDirectory: true })
    expect(result.configDir).toBe(seatPath)
    expect(existsSync(join(a.managedAuthPath, 'session'))).toBe(false)
    expect(writeActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(shareDefaultSessionRegistry).not.toHaveBeenCalled()
  })
  it('launches different accounts in different credential directories', async () => {
    const a = account('a'),
      b = account('b')
    const [first, second] = await Promise.all([
      prepareClaudeAccountSession(a),
      prepareClaudeAccountSession(b)
    ])
    expect(first.configDir).not.toBe(second.configDir)
    expect(readFileSync(join(first.configDir, '.credentials.json'), 'utf8')).toBe(
      credential('a-credential')
    )
    expect(readFileSync(join(second.configDir, '.credentials.json'), 'utf8')).toBe(
      credential('b-credential')
    )
  })
  it.each(['darwin', 'linux'] as const)(
    'launches a saved login with restored sessions without overwriting an empty profile on %s',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      seedLiveClaudePtysFromPersistence(['restored-unknown'])
      confirmSeededClaudeLivePtys(['restored-unknown'])
      const a = account('signed-in')
      const seatPath = join(a.managedAuthPath, 'empty-seat')
      const emptyCredentials = JSON.stringify({
        claudeAiOauth: { accessToken: 'expired', expiresAt: 0 }
      })
      mkdirSync(seatPath)
      writeFileSync(join(seatPath, '.credentials.json'), emptyCredentials)
      vi.mocked(claudeSeatDirectories).mockReturnValue([{ provider: 'claude', path: seatPath }])
      vi.mocked(readClaudeSeatCredentials).mockResolvedValue(emptyCredentials)
      vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue(
        credential('signed-in-credential')
      )
      vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(null)

      const result = await prepareClaudeAccountSession(a)

      expect(result.configDir).toBe(join(a.managedAuthPath, 'session'))
      expect(readFileSync(join(seatPath, '.credentials.json'), 'utf8')).toBe(emptyCredentials)
      if (platform === 'darwin') {
        expect(writeActiveClaudeKeychainCredentials).toHaveBeenCalledExactlyOnceWith(
          credential('signed-in-credential'),
          result.configDir
        )
      } else {
        expect(readFileSync(join(result.configDir, '.credentials.json'), 'utf8')).toBe(
          credential('signed-in-credential')
        )
      }
    }
  )
  it('preserves CLI token refreshes across subsequent launches', async () => {
    const a = account('a')
    const first = await prepareClaudeAccountSession(a)
    writeFileSync(
      join(first.configDir, '.credentials.json'),
      credential('cli-refreshed-credential')
    )
    const next = await prepareClaudeAccountSession(a)
    expect(next.configDir).toBe(first.configDir)
    expect(await readClaudeAccountSessionCredentials(a.id, a.managedAuthPath, 1)).toBe(
      credential('cli-refreshed-credential')
    )
    expect(readFileSync(join(a.managedAuthPath, '.credentials.json'), 'utf8')).toBe(
      credential('a-credential')
    )
  })
  it('preserves an expired session with a rotated refresh token', async () => {
    const a = account('expired')
    const first = await prepareClaudeAccountSession(a)
    const rotated = credential('rotated', 1)
    writeFileSync(join(first.configDir, '.credentials.json'), rotated)
    await prepareClaudeAccountSession(a)
    expect(await readClaudeAccountSessionCredentials(a.id, a.managedAuthPath, 1)).toBe(rotated)
  })
  it('uses a new authentication revision on the next launch', async () => {
    const a = account('a')
    const first = await prepareClaudeAccountSession(a)
    writeFileSync(join(a.managedAuthPath, '.credentials.json'), credential('reauthenticated'))
    await prepareClaudeAccountSession({ ...a, lastAuthenticatedAt: 2 })
    expect(readFileSync(join(first.configDir, '.credentials.json'), 'utf8')).toBe(
      credential('reauthenticated')
    )
  })
  it('refuses a session directory redirected outside account storage', async () => {
    const a = account('a')
    const outside = join(a.managedAuthPath, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(a.managedAuthPath, 'session'), 'dir')
    await expect(prepareClaudeAccountSession(a)).rejects.toThrow('not owned')
  })
})

it('does not reseed rejected managed credentials when preserving a session directory', async () => {
  const selected = account('rejected')
  const raw = readFileSync(join(selected.managedAuthPath, '.credentials.json'), 'utf8')
  rejectClaudeSource(
    {
      ...claudeCredentialHealth(raw),
      kind: 'managed',
      read: async () => raw,
      path: join(selected.managedAuthPath, 'session')
    },
    raw
  )
  await expect(
    prepareClaudeAccountSession(selected, { preserveSessionDirectory: true })
  ).rejects.toThrow('Sign in to this Claude account again before launching.')
  expect(existsSync(join(selected.managedAuthPath, 'session'))).toBe(false)
})

it('copies resume artifacts into a newly discovered seat without copying credentials', async () => {
  const a = account('resume')
  const session = join(a.managedAuthPath, 'session')
  const project = join(session, 'projects', 'project')
  mkdirSync(join(project, 'conversation'), { recursive: true })
  const transcriptPath = join(project, 'conversation.jsonl')
  writeFileSync(transcriptPath, 'transcript')
  writeFileSync(join(project, 'conversation', 'artifact'), 'artifact')
  const seatPath = join(a.managedAuthPath, 'seat')
  vi.mocked(claudeSeatDirectories)
    .mockReturnValueOnce([])
    .mockReturnValue([{ provider: 'claude', path: seatPath }])
  const result = await prepareClaudeAccountSession(a, {
    preserveSessionDirectory: true,
    transcriptPath
  })
  expect(result.configDir).toBe(seatPath)
  expect(readFileSync(join(seatPath, 'projects', 'project', 'conversation.jsonl'), 'utf8')).toBe(
    'transcript'
  )
  expect(
    readFileSync(join(seatPath, 'projects', 'project', 'conversation', 'artifact'), 'utf8')
  ).toBe('artifact')
  expect(existsSync(join(seatPath, '.credentials.json'))).toBe(false)
  expect(existsSync(join(session, '.credentials.json'))).toBe(false)
})
