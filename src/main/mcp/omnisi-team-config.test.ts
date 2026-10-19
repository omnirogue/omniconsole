import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import { updateTeamConnectorConfig } from './connector-config-preservation'
import { prepareTeamConnectorForLaunch, setTeamLaunchConnection } from '../omnisi-team/launch'
import * as writer from '../codex-accounts/fs-utils'

const { parse } = require('smol-toml') as typeof SmolToml
const directory = mkdtempSync(join(tmpdir(), 'omnisi-config-'))
afterEach(() => {
  setTeamLaunchConnection(null)
  vi.restoreAllMocks()
})
// Each test owns a distinct file; no provider account home is touched.
describe('secret-free team MCP configs', () => {
  for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) {
    it(`${provider}: preserves internal MCP and disconnects without writing a key`, () => {
      const toml = provider === 'codex' || provider === 'grok'
      const collection = toml ? 'mcp_servers' : 'mcpServers'
      const file = join(directory, `${provider}.${toml ? 'toml' : 'json'}`)
      const internal = { url: 'https://internal.example/mcp' }
      writeFileSync(
        file,
        toml
          ? '[mcp_servers.internal]\nurl="https://internal.example/mcp"\n'
          : JSON.stringify({ mcpServers: { internal }, unrelated: true })
      )
      const spy = vi.spyOn(writer, 'writeFileAtomicallyIfUnchanged')
      const key = 'osc1.obviously-fake-test-key'
      setTeamLaunchConnection({
        server: 'https://team.example/mcp',
        key,
        team: 'org-fake',
        installation: 'test'
      })
      const env = { KEEP_ME: 'yes' }
      prepareTeamConnectorForLaunch(provider, file, env)
      expect(env).toEqual({ KEEP_ME: 'yes', OMNICONSOLE_OMNISI_AUTHORIZATION: `Bearer ${key}` })
      expect(JSON.stringify(spy.mock.calls)).not.toContain(key)
      const text = readFileSync(file, 'utf8')
      expect(text).not.toContain(key)
      expect(text).toContain('OMNICONSOLE_OMNISI_AUTHORIZATION')
      const connected = toml ? parse(text) : JSON.parse(text)
      expect(connected[collection].internal).toEqual(internal)
      updateTeamConnectorConfig(file, provider, null)
      const disconnected = toml
        ? parse(readFileSync(file, 'utf8'))
        : JSON.parse(readFileSync(file, 'utf8'))
      expect(disconnected[collection]).toEqual({ internal })
    })
  }
  it('leaves env and config byte-for-byte unchanged with the experiment off', () => {
    const file = join(directory, 'disabled.json')
    const before = '{ "mcpServers": {}, "spacing": 42 }\n'
    writeFileSync(file, before)
    const env = { KEEP_ME: 'yes' }
    const spy = vi.spyOn(writer, 'writeFileAtomicallyIfUnchanged')
    prepareTeamConnectorForLaunch('claude', file, env)
    expect(env).toEqual({ KEEP_ME: 'yes' })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(spy).not.toHaveBeenCalled()
  })
  it('refuses to replace an unrelated connector using the reserved name', () => {
    const file = join(directory, 'conflict.json')
    const before = JSON.stringify({
      mcpServers: { 'omnisi-team': { url: 'https://mine.example/mcp' } }
    })
    writeFileSync(file, before)
    expect(() => updateTeamConnectorConfig(file, 'claude', 'https://team.example/mcp')).toThrow(
      'already in use'
    )
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))
