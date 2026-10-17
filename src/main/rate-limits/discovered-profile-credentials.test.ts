import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasDiscoveredProfileCredentials } from './discovered-profile-credentials'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'

vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async () => null)
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('discovered profile credentials', () => {
  it.each(['win32', 'linux'])(
    'recognizes file-backed logins on %s without using Keychain',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      const path = mkdtempSync(join(tmpdir(), 'discovered-credentials-'))
      roots.push(path)
      writeFileSync(
        join(path, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } })
      )
      writeFileSync(
        join(path, 'auth.json'),
        JSON.stringify({ tokens: { refresh_token: 'fixture' } })
      )
      expect(await hasDiscoveredProfileCredentials({ provider: 'claude', path })).toBe(true)
      expect(await hasDiscoveredProfileCredentials({ provider: 'codex', path })).toBe(true)
      expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalled()
      writeFileSync(
        join(path, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } })
      )
      expect(await hasDiscoveredProfileCredentials({ provider: 'claude', path })).toBe(false)
    }
  )

  it('uses the global Mac credential only for the default Claude directory', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const keychain = vi.mocked(readActiveClaudeKeychainCredentialsStrict)
    keychain.mockImplementation(async (path) =>
      path ? null : JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } })
    )
    expect(
      await hasDiscoveredProfileCredentials({
        provider: 'claude',
        path: join(homedir(), '.claude')
      })
    ).toBe(true)
    keychain.mockClear()
    expect(
      await hasDiscoveredProfileCredentials({ provider: 'claude', path: '/missing/other-account' })
    ).toBe(false)
    expect(keychain).toHaveBeenCalledExactlyOnceWith('/missing/other-account')
  })
})
