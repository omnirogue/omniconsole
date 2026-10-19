import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeOmniConsoleMcpConfig,
  OMNI_CONSOLE_MCP_URL,
  omniConsoleMcpLedgerHeaders
} from '../../shared/mcp-config'
import { prepareOmniConsoleMcpForLaunch } from './omni-console-mcp-launch'
import {
  hasLaunchableOmniConsoleMcpToml,
  mergeOmniConsoleMcpToml,
  omniConsoleMcpTomlNeedsLedgerHeaders,
  preserveOmniConsoleRuntimeOverride
} from './omni-console-mcp-toml'
import { hasLaunchableOmniConsoleMcp } from './omni-console-mcp-validation'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('existing OmniConsole MCP names', () => {
  it.each(['codex', 'grok'] as const)(
    'keeps the existing %s name and upgrades its ledger headers once',
    (provider) => {
      const original = `# keep\nmodel = "custom"\n[mcp_servers.omniconsole]\nurl = "${OMNI_CONSOLE_MCP_URL}"\n`
      const merged = mergeOmniConsoleMcpToml(original, true, provider)
      expect(merged.startsWith(original)).toBe(true)
      expect(parse(merged).mcp_servers).toEqual({
        omniconsole: {
          url: OMNI_CONSOLE_MCP_URL,
          [provider === 'codex' ? 'env_http_headers' : 'headers']:
            omniConsoleMcpLedgerHeaders(provider)
        }
      })
      expect(hasLaunchableOmniConsoleMcpToml(merged)).toBe(true)
      expect(omniConsoleMcpTomlNeedsLedgerHeaders(merged, provider)).toBe(false)
      expect(mergeOmniConsoleMcpToml(merged, true, provider)).toBe(merged)
      expect(mergeOmniConsoleMcpToml(original, false, provider)).toBe(original)
    }
  )

  it.each(['claude', 'gemini'] as const)(
    'keeps the existing %s name and provider-specific ledger headers',
    (provider) => {
      const server =
        provider === 'gemini'
          ? { httpUrl: OMNI_CONSOLE_MCP_URL }
          : { type: 'http', url: OMNI_CONSOLE_MCP_URL }
      const original = { mcpServers: { omniconsole: server } }
      const merged = mergeOmniConsoleMcpConfig(original, true, provider)
      expect(merged).toEqual({
        mcpServers: {
          omniconsole: { ...server, headers: omniConsoleMcpLedgerHeaders(provider) }
        }
      })
      expect(hasLaunchableOmniConsoleMcp(merged)).toBe(true)
      expect(mergeOmniConsoleMcpConfig(merged, true, provider)).toBe(merged)
    }
  )

  it('preserves custom alias headers and provider OAuth configuration', () => {
    const original = {
      mcpServers: {
        omniconsole: {
          url: OMNI_CONSOLE_MCP_URL,
          headers: { 'X-Custom': 'keep' },
          oauth: { client_id: 'user-configured-client' }
        }
      }
    }
    expect(mergeOmniConsoleMcpConfig(original, true)).toBe(original)
    const toml = stringify({ mcp_servers: original.mcpServers })
    expect(mergeOmniConsoleMcpToml(toml, true)).toBe(toml)
    expect(hasLaunchableOmniConsoleMcp(original)).toBe(true)
  })

  it.each([
    { enabled: false, url: OMNI_CONSOLE_MCP_URL },
    { disabled: true, url: OMNI_CONSOLE_MCP_URL },
    { url: 'https://custom.example/mcp' },
    { url: OMNI_CONSOLE_MCP_URL, command: 'custom-command' }
  ])('keeps an explicit canonical override authoritative: %j', (canonical) => {
    const config = {
      mcpServers: { 'omni-console': canonical, omniconsole: { url: OMNI_CONSOLE_MCP_URL } }
    }
    expect(mergeOmniConsoleMcpConfig(config, true)).toBe(config)
    expect(() => hasLaunchableOmniConsoleMcp(config)).toThrow('disabled or overridden')
    const toml = stringify({ mcp_servers: config.mcpServers })
    expect(mergeOmniConsoleMcpToml(toml, true)).toBe(toml)
    expect(() => hasLaunchableOmniConsoleMcpToml(toml)).toThrow('disabled or overridden')
  })

  it.each([
    { disabledMcpServers: ['omniconsole'] },
    { disabledMcpjsonServers: ['omniconsole'] },
    { disabled_mcp_servers: ['omniconsole'] },
    { mcp: { excluded: ['omniconsole'] } },
    { mcp: { allowed: ['other'] } }
  ])('preserves an alias disabled by provider configuration: %j', (restrictions) => {
    const mcpServers = { omniconsole: { url: OMNI_CONSOLE_MCP_URL } }
    const config = { ...restrictions, mcpServers }
    expect(mergeOmniConsoleMcpConfig(config, true)).toBe(config)
    expect(() => hasLaunchableOmniConsoleMcp(config)).toThrow('disabled or overridden')
    const toml = stringify({ ...restrictions, mcp_servers: mcpServers })
    expect(mergeOmniConsoleMcpToml(toml, true)).toBe(toml)
    expect(() => hasLaunchableOmniConsoleMcpToml(toml)).toThrow('disabled or overridden')
  })

  it.each([{ enabled: false }, { disabled: true }])(
    'does not replace an explicitly disabled alias: %j',
    (disabled) => {
      const config = {
        mcpServers: { omniconsole: { url: OMNI_CONSOLE_MCP_URL, ...disabled } }
      }
      expect(mergeOmniConsoleMcpConfig(config, true)).toBe(config)
      expect(() => hasLaunchableOmniConsoleMcp(config)).toThrow('disabled or overridden')
      const toml = stringify({ mcp_servers: config.mcpServers })
      expect(mergeOmniConsoleMcpToml(toml, true)).toBe(toml)
      expect(() => hasLaunchableOmniConsoleMcpToml(toml)).toThrow('disabled or overridden')
    }
  )

  it('respects an explicit canonical disable even with an enabled alias', () => {
    const config = {
      disabledMcpServers: ['omni-console'],
      mcpServers: { omniconsole: { url: OMNI_CONSOLE_MCP_URL } }
    }
    expect(mergeOmniConsoleMcpConfig(config, true)).toBe(config)
    expect(() => hasLaunchableOmniConsoleMcp(config)).toThrow('disabled or overridden')
  })

  it('uses an allowed active alias when another alias is disabled', () => {
    const config = {
      mcp: { allowed: ['active'] },
      mcpServers: {
        parked: { url: OMNI_CONSOLE_MCP_URL, enabled: false },
        active: { url: OMNI_CONSOLE_MCP_URL }
      }
    }
    expect(hasLaunchableOmniConsoleMcp(config)).toBe(true)
    expect(mergeOmniConsoleMcpConfig(config, true)).toEqual({
      ...config,
      mcpServers: {
        ...config.mcpServers,
        active: { ...config.mcpServers.active, headers: omniConsoleMcpLedgerHeaders('claude') }
      }
    })
  })

  it.each([
    { url: 'https://app.omnisi.ai/another' },
    { url: 'http://console.omnisi.ai/mcp' },
    { url: OMNI_CONSOLE_MCP_URL, command: 'custom-command' },
    { url: OMNI_CONSOLE_MCP_URL, type: 'stdio' }
  ])('does not treat another endpoint or transport as the connector: %j', (other) => {
    const config = { mcpServers: { other } }
    expect(hasLaunchableOmniConsoleMcp(config)).toBe(false)
    expect(mergeOmniConsoleMcpConfig(config, true).mcpServers).toHaveProperty('omni-console')
    const merged = mergeOmniConsoleMcpToml(stringify({ mcp_servers: { other } }), true)
    expect(parse(merged).mcp_servers).toHaveProperty('omni-console')
  })

  it('escapes an existing TOML alias when adding header tables', () => {
    const name = 'console "personal"'
    const original = stringify({ mcp_servers: { [name]: { url: OMNI_CONSOLE_MCP_URL } } })
    const merged = mergeOmniConsoleMcpToml(original, true)
    expect(Object.keys(parse(merged).mcp_servers as object)).toEqual([name])
    expect(omniConsoleMcpTomlNeedsLedgerHeaders(merged, 'codex')).toBe(false)
  })

  it('preserves the same alias runtime override without moving it to another name', () => {
    const original = `[mcp_servers.omniconsole]\nurl = "${OMNI_CONSOLE_MCP_URL}"\n`
    const system = mergeOmniConsoleMcpToml(original, true)
    const runtime = `${original}enabled = false\n`
    expect(parse(preserveOmniConsoleRuntimeOverride(runtime, system))).toEqual(parse(runtime))
  })

  it('does not add a second name during managed Codex launch preparation', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-mcp-alias-'))
    roots.push(home)
    const runtime = join(home, 'runtime')
    mkdirSync(join(home, '.codex'))
    mkdirSync(runtime)
    const original = `[mcp_servers.omniconsole]\nurl = "${OMNI_CONSOLE_MCP_URL}"\n`
    writeFileSync(join(home, '.codex', 'config.toml'), original)
    writeFileSync(join(runtime, 'config.toml'), original)
    prepareOmniConsoleMcpForLaunch({
      home,
      provider: 'codex',
      signedIn: true,
      env: { CODEX_HOME: runtime, ORCA_CODEX_HOME: runtime }
    })
    for (const path of [join(home, '.codex', 'config.toml'), join(runtime, 'config.toml')]) {
      const content = readFileSync(path, 'utf8')
      // The point of this test is that the console connector is not duplicated under a second
      // name; Notion is provided alongside it and is not part of that claim.
      const names = Object.keys(parse(content).mcp_servers as object)
      expect(names.filter((name) => name !== 'notion')).toEqual(['omniconsole'])
      expect(omniConsoleMcpTomlNeedsLedgerHeaders(content, 'codex')).toBe(false)
    }
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })
})
