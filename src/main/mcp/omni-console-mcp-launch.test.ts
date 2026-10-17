import { parse } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NOTION_MCP_NAME, NOTION_MCP_URL } from '../../shared/notion-mcp'
import { prepareOmniConsoleMcpForLaunch } from './omni-console-mcp-launch'
import {
  mergeOmniConsoleMcpToml,
  preserveOmniConsoleRuntimeOverride
} from './omni-console-mcp-toml'
import { OMNI_CONSOLE_MCP_URL, omniConsoleMcpLedgerHeaders } from '../../shared/mcp-config'
import {
  OMNI_LEDGER_ATTEMPT_HEADER,
  OMNI_LEDGER_SESSION_HEADER
} from '../../shared/session-ledger-env'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'omni-mcp-'))
  vi.stubEnv('CODEX_HOME', '')
  vi.stubEnv('ORCA_CODEX_HOME', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('GROK_HOME', '')
  vi.stubEnv('GEMINI_CLI_HOME', '')
  vi.stubEnv('XDG_CONFIG_HOME', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('provider MCP launch configuration', () => {
  it.each(['claude', 'codex', 'gemini', 'grok'] as const)(
    'does not materialize %s config while signed out',
    (provider) => {
      prepareOmniConsoleMcpForLaunch({ provider, home, signedIn: false })
      expect(existsSync(join(home, '.claude.json'))).toBe(false)
      expect(existsSync(join(home, '.codex'))).toBe(false)
      expect(existsSync(join(home, '.gemini'))).toBe(false)
      expect(existsSync(join(home, '.grok'))).toBe(false)
    }
  )

  it('preserves Claude account state and adds no credentials to its MCP entry', () => {
    const path = join(home, '.claude.json')
    write(
      path,
      JSON.stringify({ account: 'existing', mcpServers: { custom: { command: 'custom' } } })
    )
    prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      account: 'existing',
      mcpServers: {
        custom: { command: 'custom' },
        'omni-console': {
          type: 'http',
          url: OMNI_CONSOLE_MCP_URL,
          headers: {
            [OMNI_LEDGER_SESSION_HEADER]: '${OMNI_LEDGER_SESSION_ID:-}',
            [OMNI_LEDGER_ATTEMPT_HEADER]: '${OMNI_LEDGER_ATTEMPT_ID:-}'
          }
        },
        // Provided alongside the console connector; it authenticates per person in a browser,
        // so the entry is a URL and never a credential.
        [NOTION_MCP_NAME]: { type: 'http', url: NOTION_MCP_URL }
      }
    })
  })

  it('upgrades a Claude entry written before the ledger headers exactly once', () => {
    const path = join(home, '.claude.json')
    write(
      path,
      JSON.stringify({
        mcpServers: { 'omni-console': { type: 'http', url: OMNI_CONSOLE_MCP_URL } }
      })
    )
    prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    const upgraded = readFileSync(path, 'utf8')
    expect(JSON.parse(upgraded).mcpServers['omni-console'].headers).toEqual(
      omniConsoleMcpLedgerHeaders('claude')
    )
    prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    expect(readFileSync(path, 'utf8')).toBe(upgraded)
  })

  it('rewrites a legacy managed Claude entry to the helper shape on a local spawn, once', () => {
    const helper = '/App/Resources/mcp/omni-console-mcp-headers.sh'
    const path = join(home, '.claude.json')
    write(
      path,
      JSON.stringify({
        mcpServers: {
          'omni-console': {
            type: 'http',
            url: OMNI_CONSOLE_MCP_URL,
            headers: omniConsoleMcpLedgerHeaders('claude')
          }
        }
      })
    )
    prepareOmniConsoleMcpForLaunch({
      provider: 'claude',
      home,
      signedIn: true,
      claudeHeadersHelper: helper
    })
    const upgraded = readFileSync(path, 'utf8')
    expect(JSON.parse(upgraded).mcpServers['omni-console']).toEqual({
      type: 'http',
      url: OMNI_CONSOLE_MCP_URL,
      headersHelper: helper
    })
    prepareOmniConsoleMcpForLaunch({
      provider: 'claude',
      home,
      signedIn: true,
      claudeHeadersHelper: helper
    })
    expect(readFileSync(path, 'utf8')).toBe(upgraded)
    // A later spawn without the helper (relay/WSL path) neither downgrades nor adds headers.
    prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    expect(readFileSync(path, 'utf8')).toBe(upgraded)
  })

  it("leaves a person's own connector entry alone even when it has our endpoint", () => {
    const path = join(home, '.claude.json')
    const own = JSON.stringify({
      mcpServers: {
        'omni-console': { type: 'http', url: OMNI_CONSOLE_MCP_URL, headers: { 'X-Custom': '1' } }
      }
    })
    write(path, own)
    prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    // Their console entry is untouched, headers and all. The file itself is rewritten only
    // because Notion is now provided too, and that addition must not disturb what they wrote.
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.mcpServers['omni-console']).toEqual(JSON.parse(own).mcpServers['omni-console'])
    expect(after.mcpServers[NOTION_MCP_NAME]).toEqual({ type: 'http', url: NOTION_MCP_URL })
  })

  it('uses the selected Claude configuration directory', () => {
    const selected = join(home, 'selected-claude')
    prepareOmniConsoleMcpForLaunch({
      provider: 'claude',
      home,
      signedIn: true,
      env: { CLAUDE_CONFIG_DIR: selected }
    })
    expect(readFileSync(join(selected, '.claude.json'), 'utf8')).toContain(OMNI_CONSOLE_MCP_URL)
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('preserves workspace disabling and refuses to launch without the connector', () => {
    const cwd = join(home, 'repo')
    write(
      join(cwd, '.claude/settings.local.json'),
      JSON.stringify({ disabledMcpjsonServers: ['omni-console'] })
    )
    expect(() =>
      prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, cwd, signedIn: true })
    ).toThrow('disabled or overridden')
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('does not replace malformed user configuration', () => {
    const path = join(home, '.claude.json')
    write(path, '{unfinished')
    expect(() =>
      prepareOmniConsoleMcpForLaunch({ provider: 'claude', home, signedIn: true })
    ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{unfinished')
  })

  it('updates a symlink target without replacing the user symlink', () => {
    if (process.platform === 'win32') {
      return
    }
    const target = join(home, 'dotfiles', 'codex.toml')
    write(target, '# user comment\nmodel = "custom"\n')
    mkdirSync(join(home, '.codex'))
    symlinkSync(target, join(home, '.codex/config.toml'))
    prepareOmniConsoleMcpForLaunch({ provider: 'codex', home, signedIn: true })
    expect(readFileSync(target, 'utf8')).toContain(OMNI_CONSOLE_MCP_URL)
  })

  it('prepares both the managed Codex home and its mirrored source', () => {
    const selected = join(home, 'managed')
    prepareOmniConsoleMcpForLaunch({
      provider: 'codex',
      home,
      signedIn: true,
      env: { CODEX_HOME: selected, ORCA_CODEX_HOME: selected }
    })
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain(OMNI_CONSOLE_MCP_URL)
    expect(readFileSync(join(selected, 'config.toml'), 'utf8')).toContain(OMNI_CONSOLE_MCP_URL)
  })

  it('writes Gemini streamable HTTP config while preserving account settings', () => {
    const selectedHome = join(home, 'gemini-account')
    const path = join(selectedHome, '.gemini', 'settings.json')
    write(
      path,
      JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: { other: { command: 'other' } }
      })
    )
    prepareOmniConsoleMcpForLaunch({
      provider: 'gemini',
      home,
      signedIn: true,
      env: { GEMINI_CLI_HOME: selectedHome }
    })
    const config = JSON.parse(readFileSync(path, 'utf8'))
    expect(config.security.auth.selectedType).toBe('oauth-personal')
    expect(config.mcpServers).toEqual({
      other: { command: 'other' },
      'omni-console': {
        httpUrl: OMNI_CONSOLE_MCP_URL,
        headers: {
          [OMNI_LEDGER_SESSION_HEADER]: '${OMNI_LEDGER_SESSION_ID}',
          [OMNI_LEDGER_ATTEMPT_HEADER]: '${OMNI_LEDGER_ATTEMPT_ID}'
        }
      },
      // Gemini reads the URL under httpUrl, so the provided Notion entry uses that field too.
      [NOTION_MCP_NAME]: { httpUrl: NOTION_MCP_URL }
    })
    const first = readFileSync(path, 'utf8')
    prepareOmniConsoleMcpForLaunch({
      provider: 'gemini',
      home,
      signedIn: true,
      env: { GEMINI_CLI_HOME: selectedHome }
    })
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('writes Grok native TOML in the selected home without losing existing comments', () => {
    const selectedHome = join(home, 'grok-account')
    const path = join(selectedHome, 'config.toml')
    const original = '# keep this comment\n[ui]\nscreen_mode = "minimal"\n'
    write(path, original)
    prepareOmniConsoleMcpForLaunch({
      provider: 'grok',
      home,
      signedIn: true,
      env: { GROK_HOME: selectedHome }
    })
    expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true)
    expect(parse(readFileSync(path, 'utf8')).mcp_servers).toEqual({
      'omni-console': {
        url: OMNI_CONSOLE_MCP_URL,
        headers: {
          [OMNI_LEDGER_SESSION_HEADER]: '${OMNI_LEDGER_SESSION_ID:-}',
          [OMNI_LEDGER_ATTEMPT_HEADER]: '${OMNI_LEDGER_ATTEMPT_ID:-}'
        }
      },
      [NOTION_MCP_NAME]: { url: NOTION_MCP_URL }
    })
    expect(existsSync(join(home, '.grok/config.toml'))).toBe(false)
  })

  it('writes Codex env-named ledger headers and upgrades an endpoint-only entry once', () => {
    const path = join(home, '.codex/config.toml')
    const original = `# keep\nmodel = "custom"\n\n[mcp_servers."omni-console"]\nurl = "${OMNI_CONSOLE_MCP_URL}"\n`
    write(path, original)
    prepareOmniConsoleMcpForLaunch({ provider: 'codex', home, signedIn: true })
    const upgraded = readFileSync(path, 'utf8')
    expect(upgraded.startsWith(original)).toBe(true)
    expect(parse(upgraded).mcp_servers).toEqual({
      'omni-console': {
        url: OMNI_CONSOLE_MCP_URL,
        env_http_headers: {
          [OMNI_LEDGER_SESSION_HEADER]: 'OMNI_LEDGER_SESSION_ID',
          [OMNI_LEDGER_ATTEMPT_HEADER]: 'OMNI_LEDGER_ATTEMPT_ID'
        }
      },
      [NOTION_MCP_NAME]: { url: NOTION_MCP_URL }
    })
    prepareOmniConsoleMcpForLaunch({ provider: 'codex', home, signedIn: true })
    expect(readFileSync(path, 'utf8')).toBe(upgraded)
  })

  it('upgrades a Grok endpoint-only entry with expanded-env headers', () => {
    const selectedHome = join(home, 'grok-account')
    const path = join(selectedHome, 'config.toml')
    write(path, `[mcp_servers.omni-console]\nurl = "${OMNI_CONSOLE_MCP_URL}"\nenabled = true\n`)
    prepareOmniConsoleMcpForLaunch({
      provider: 'grok',
      home,
      signedIn: true,
      env: { GROK_HOME: selectedHome }
    })
    expect(parse(readFileSync(path, 'utf8')).mcp_servers).toEqual({
      'omni-console': {
        url: OMNI_CONSOLE_MCP_URL,
        enabled: true,
        headers: omniConsoleMcpLedgerHeaders('grok')
      },
      [NOTION_MCP_NAME]: { url: NOTION_MCP_URL }
    })
  })

  it.each(['gemini', 'grok'] as const)(
    'uses the %s workspace config in a plain folder',
    (provider) => {
      const cwd = join(home, 'folder')
      const path = join(cwd, `.${provider}`, provider === 'grok' ? 'config.toml' : 'settings.json')
      const original =
        provider === 'grok'
          ? mergeOmniConsoleMcpToml('', true, 'grok')
          : JSON.stringify({ mcpServers: { 'omni-console': { httpUrl: OMNI_CONSOLE_MCP_URL } } })
      write(path, original)
      prepareOmniConsoleMcpForLaunch({ provider, cwd, home, signedIn: true })
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(existsSync(join(home, `.${provider}`))).toBe(false)
    }
  )

  it('does not call a Gemini declaration healthy when its user allowlist excludes the server', () => {
    const path = join(home, '.gemini/settings.json')
    const original = JSON.stringify({ mcp: { allowed: ['other'] } })
    write(path, original)
    expect(() =>
      prepareOmniConsoleMcpForLaunch({ provider: 'gemini', home, signedIn: true })
    ).toThrow('disabled or overridden')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})

describe('Codex MCP TOML merge', () => {
  it('preserves comments and unrelated server bytes, and is idempotent', () => {
    const user = '# user comment\n[mcp_servers.custom]\ncommand = "tool"\n'
    const merged = mergeOmniConsoleMcpToml(user, true)
    expect(merged.startsWith(user)).toBe(true)
    expect(merged).toContain(`[mcp_servers."omni-console"]\nurl = "${OMNI_CONSOLE_MCP_URL}"`)
    expect(mergeOmniConsoleMcpToml(merged, true)).toBe(merged)
    expect(mergeOmniConsoleMcpToml(user, false)).toBe(user)
  })

  it.each([
    '[mcp_servers.omni-console]\nenabled = false',
    '[mcp_servers."omni-console"]\nurl = "https://custom.test/mcp"',
    '[mcp_servers]\n"omni-console" = { enabled = false }',
    'mcp_servers.omni-console.enabled = false',
    'mcp_servers = { "omni-console" = { enabled = false } }'
  ])('preserves provider-owned declarations: %s', (config) => {
    expect(mergeOmniConsoleMcpToml(config, true)).toBe(config)
  })

  it('does not confuse a multiline string with server configuration', () => {
    const config = 'instructions = """\n[mcp_servers.omni-console]\n"""\n'
    expect(mergeOmniConsoleMcpToml(config, true)).toContain(OMNI_CONSOLE_MCP_URL)
  })
})

describe('managed-home MCP override preservation', () => {
  it('keeps a managed-home disable when refreshing the shipped default', () => {
    const system = mergeOmniConsoleMcpToml('model = "user"\n', true)
    const runtime = '[mcp_servers."omni-console"]\nenabled = false\n'
    const merged = preserveOmniConsoleRuntimeOverride(runtime, system)
    expect(merged).toContain('model = "user"')
    expect(merged).toContain('enabled = false')
    expect(merged).not.toContain(OMNI_CONSOLE_MCP_URL)
  })

  it('keeps a custom runtime URL and its OAuth settings without changing the system source', () => {
    const system = mergeOmniConsoleMcpToml('', true)
    const runtime =
      '[mcp_servers.omni-console]\nurl = "https://custom.test/mcp"\n' +
      '[mcp_servers.omni-console.oauth]\nclient_id = "custom"\n'
    expect(parse(preserveOmniConsoleRuntimeOverride(runtime, system))).toEqual(parse(runtime))
    expect(system).toContain(OMNI_CONSOLE_MCP_URL)
  })

  it('lets explicit system configuration take precedence over the old default', () => {
    const runtime = mergeOmniConsoleMcpToml('', true)
    const system = '[mcp_servers.omni-console]\nenabled = false\n'
    expect(preserveOmniConsoleRuntimeOverride(runtime, system)).toBe(system)
  })
})

describe('inline and dotted provider configuration', () => {
  it.each(['mcp_servers = {}', 'mcp_servers = { custom = { command = "tool" } }'])(
    'adds the default to an inline server collection: %s',
    (config) => {
      const result = parse(mergeOmniConsoleMcpToml(config, true))
      expect(result.mcp_servers).toMatchObject({ 'omni-console': { url: OMNI_CONSOLE_MCP_URL } })
      if (config.includes('custom')) {
        expect(result.mcp_servers).toMatchObject({ custom: { command: 'tool' } })
      }
    }
  )
  it.each([
    'mcp_servers.omni-console.enabled = false',
    'mcp_servers = { "omni-console" = { enabled = false } }',
    '[mcp_servers]\n"omni-console" = { enabled = false }'
  ])('preserves a disable through a managed refresh: %s', (runtime) => {
    const result = preserveOmniConsoleRuntimeOverride(runtime, mergeOmniConsoleMcpToml('', true))
    expect(parse(result).mcp_servers).toMatchObject({ 'omni-console': { enabled: false } })
  })
})

describe('Muse MCP launch configuration', () => {
  const museEntry = { type: 'streamable-http', url: OMNI_CONSOLE_MCP_URL, mode: 'optional' }
  const settingsPath = (): string => join(home, '.config', 'muse', 'settings.json')

  it('adds the connector to existing Muse settings and keeps every other key', () => {
    const settings = {
      schema_version: 1,
      model: 'muse-wonder-full-1.0',
      mcpServers: { custom: { type: 'stdio', command: 'tool', mode: 'optional' } }
    }
    write(settingsPath(), JSON.stringify(settings))
    prepareOmniConsoleMcpForLaunch({ provider: 'muse', home, signedIn: true })
    // No Notion and no ledger headers: Muse would send a `${VAR}` reference verbatim.
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      ...settings,
      mcpServers: { ...settings.mcpServers, 'omni-console': museEntry }
    })
  })

  it('creates settings in Muse shape when Muse is set up but has none yet', () => {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    prepareOmniConsoleMcpForLaunch({ provider: 'muse', home, signedIn: true })
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      schema_version: 1,
      mcpServers: { 'omni-console': museEntry }
    })
  })

  it('leaves a host without Muse untouched', () => {
    prepareOmniConsoleMcpForLaunch({ provider: 'muse', home, signedIn: true })
    expect(existsSync(join(home, '.config'))).toBe(false)
  })

  it('uses XDG_CONFIG_HOME when it is set', () => {
    const xdg = join(home, 'xdg')
    mkdirSync(join(xdg, 'muse'), { recursive: true })
    prepareOmniConsoleMcpForLaunch({
      provider: 'muse',
      home,
      env: { XDG_CONFIG_HOME: xdg },
      signedIn: true
    })
    expect(JSON.parse(readFileSync(join(xdg, 'muse', 'settings.json'), 'utf8'))).toEqual({
      schema_version: 1,
      mcpServers: { 'omni-console': museEntry }
    })
  })

  it.each([
    ['a legacy mcp_servers key', { schema_version: 1, mcp_servers: { custom: { command: 'x' } } }],
    [
      'an existing entry',
      { mcpServers: { 'omni-console': { ...museEntry, mode: 'required', headers: { A: 'b' } } } }
    ],
    ['an alias for the endpoint', { mcpServers: { omnios: museEntry } }]
  ])('leaves settings with %s as they are', (_label, settings) => {
    const content = JSON.stringify(settings)
    write(settingsPath(), content)
    prepareOmniConsoleMcpForLaunch({ provider: 'muse', home, signedIn: true })
    expect(readFileSync(settingsPath(), 'utf8')).toBe(content)
  })
})
