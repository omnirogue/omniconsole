import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { parseTeamConnection, TeamConnectionStore } from './connection'

const key = 'osc1.obviously-fake-test-key'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'omnisi-team-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  _resetSecretStoreForTests()
  vi.restoreAllMocks()
})
describe('team credentials', () => {
  it('imports the server card and rejects keys in URLs', () => {
    const server = 'https://team.example/mcp'
    expect(
      parseTeamConnection(
        JSON.stringify({
          mcpServers: { omnisi: { url: server, headers: { Authorization: `Bearer ${key}` } } }
        }),
        ''
      )
    ).toEqual({ server, key })
    for (
      const url of [
        `${server}?key=${key}`,
        `${server}#${key}`,
        'https://user:password@team.example/mcp',
        'http://team.example/mcp',
        'https://team.example/other'
      ]
    ) {
      expect(() => parseTeamConnection(url, key)).toThrow('Use the HTTPS')
    }
    expect(() => parseTeamConnection(server, 'not-a-team-key')).toThrow()
  })
  it('seals before writing, round trips and removes the key without logging it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let sealed = ''
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => {
        sealed = value
        return Buffer.from('fake-os-ciphertext')
      },
      decryptString: () => sealed
    })
    const file = join(directory, 'connection.sealed')
    const store = new TeamConnectionStore(file)
    const saved = store.save({ server: 'https://team.example/mcp', key, team: 'org-fake' })
    expect(readFileSync(file, 'utf8')).not.toContain(key)
    expect(store.read()).toEqual(saved)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    store.remove()
    expect(existsSync(file)).toBe(false)
  })
  it('refuses plaintext and basic_text fallback before creating a file', () => {
    for (const available of [true, false]) {
      setSecretStore({
        isEncryptionAvailable: () => available,
        describeProtectionGap: () => 'OS keyring unavailable',
        encryptString: vi.fn(),
        decryptString: vi.fn()
      })
      const file = join(directory, 'connection.sealed')
      expect(() =>
        new TeamConnectionStore(file).save({
          server: 'https://team.example/mcp',
          key,
          team: 'org-fake'
        })
      ).toThrow('Unlock your OS keychain')
      expect(existsSync(file)).toBe(false)
    }
  })
})
