import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canInspectLocalMcpConfigRoot,
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  inspectMcpConfigContent,
  maskMcpEnv,
  findOmniSiMcpName,
  isManagedOmniConsoleMcpEntry,
  isManagedOmniMcpEntry,
  isManagedOmniSiMcpEntry,
  isOmniConsoleMcpHeadersHelperCommand,
  isOmniSiMcpConfigured,
  mergeOmniConsoleMcpConfig,
  omniConsoleMcpHeadersHelperCommand,
  omniConsoleMcpLedgerHeaders,
  OMNI_CONSOLE_MCP_NAME,
  OMNI_CONSOLE_MCP_URL,
  OMNICONSOLE_DEFAULT_MCP_ENDPOINTS,
  OMNISI_MCP_NAME,
  OMNISI_MCP_URL,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG,
  selectExistingMcpConfigCandidates
} from './mcp-config'
import {
  MCP_CONFIG_INSPECTION_MAX_BYTES,
  MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS,
  MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES,
  MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from './mcp-config-inspection-limits'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp-config', () => {
  const workspaceCandidate = MCP_CONFIG_CANDIDATES[0]

  it('reports missing configs', () => {
    expect(inspectMcpConfigContent(workspaceCandidate, null)).toMatchObject({
      exists: false,
      status: 'missing',
      servers: []
    })
  })

  it('reports invalid JSON without exposing file contents', () => {
    const result = inspectMcpConfigContent(workspaceCandidate, '{')
    expect(result.status).toBe('invalid')
    expect(result.error).toContain('JSON')
    expect(result.servers).toEqual([])
  })

  it('summarizes stdio, http, disabled, and invalid servers', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: { NODE_ENV: 'production', API_TOKEN: 'secret-token' }
          },
          docs: { type: 'http', url: 'https://example.com/mcp' },
          old: { command: 'node', enabled: false },
          broken: { args: ['missing-command'] }
        }
      })
    )

    expect(result.status).toBe('valid')
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        transport: 'stdio',
        status: 'enabled',
        command: 'npx',
        env: { NODE_ENV: 'production', API_TOKEN: '••••••••' }
      },
      {
        name: 'docs',
        transport: 'http',
        status: 'enabled',
        url: 'https://example.com/mcp'
      },
      {
        name: 'old',
        transport: 'stdio',
        status: 'disabled',
        command: 'node'
      },
      {
        name: 'broken',
        transport: 'unknown',
        status: 'invalid',
        issue: 'Missing command or URL.'
      }
    ])
  })

  it('supports agent-specific command and URL shapes from common adapters', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          opencodeLocal: { type: 'local', command: ['uvx', 'server'] },
          geminiRemote: { httpUrl: 'https://example.com/sse' }
        }
      })
    )

    expect(result.servers).toMatchObject([
      { name: 'opencodeLocal', transport: 'stdio', command: 'uvx' },
      { name: 'geminiRemote', transport: 'http', url: 'https://example.com/sse' }
    ])
  })

  it('marks declared transports without their target as invalid', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          remoteMissingUrl: { type: 'http' },
          localMissingCommand: { type: 'local' }
        }
      })
    )

    expect(result.servers).toEqual([
      {
        name: 'remoteMissingUrl',
        transport: 'http',
        status: 'invalid',
        issue: 'Missing URL.'
      },
      {
        name: 'localMissingCommand',
        transport: 'stdio',
        status: 'invalid',
        issue: 'Missing command.'
      }
    ])
  })

  it('masks env values that look sensitive by key or value', () => {
    expect(
      maskMcpEnv({
        NORMAL: 'visible',
        PASSWORD: 'hunter2',
        MAYBE: 'sk-abc123456789xyz'
      })
    ).toEqual({
      NORMAL: 'visible',
      PASSWORD: '••••••••',
      MAYBE: '••••••••'
    })
  })

  it('keeps starter config valid and empty', () => {
    expect(inspectMcpConfigContent(workspaceCandidate, MCP_STARTER_CONFIG)).toMatchObject({
      exists: true,
      status: 'valid',
      servers: []
    })
  })

  it('parses the exact input boundary and rejects +1 before JSON parsing', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const exact = `${' '.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES - 2)}{}`

    expect(inspectMcpConfigContent(workspaceCandidate, exact).status).toBe('valid')
    expect(parse).toHaveBeenCalledOnce()

    parse.mockClear()
    expect(inspectMcpConfigContent(workspaceCandidate, `${exact} `).status).toBe('invalid')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('rejects multibyte input over the byte cap before JSON parsing', () => {
    const parse = vi.spyOn(JSON, 'parse')

    expect(
      inspectMcpConfigContent(
        workspaceCandidate,
        'é'.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES / 2 + 1)
      ).status
    ).toBe('invalid')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('admits the exact server cardinality and rejects +1', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_SERVERS }, (_, index) => [
        `server-${index}`,
        { command: 'node' }
      ])
    )

    expect(
      inspectMcpConfigContent(workspaceCandidate, JSON.stringify({ mcpServers: servers })).servers
    ).toHaveLength(MCP_CONFIG_INSPECTION_MAX_SERVERS)
    servers.overflow = { command: 'node' }
    expect(
      inspectMcpConfigContent(workspaceCandidate, JSON.stringify({ mcpServers: servers }))
    ).toMatchObject({ status: 'invalid', servers: [] })
  })

  it('admits an exact-size command and rejects the field at +1', () => {
    const exact = 'x'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS)
    const exactUtf8 = 'é'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES / 2)
    const inspectCommand = (command: string) =>
      inspectMcpConfigContent(
        workspaceCandidate,
        JSON.stringify({ mcpServers: { bounded: { command } } })
      ).servers[0]

    expect(inspectCommand(exact)).toMatchObject({ status: 'enabled', command: exact })
    expect(inspectCommand(`${exact}x`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
    expect(inspectCommand(exactUtf8)).toMatchObject({ status: 'enabled', command: exactUtf8 })
    expect(inspectCommand(`${exactUtf8}é`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
  })

  it('admits the exact env cardinality and rejects +1 without retaining env values', () => {
    const env = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS }, (_, index) => [
        `KEY_${index}`,
        'value'
      ])
    )
    const inspectEnv = () =>
      inspectMcpConfigContent(
        workspaceCandidate,
        JSON.stringify({ mcpServers: { bounded: { command: 'node', env } } })
      ).servers[0]

    expect(Object.keys(inspectEnv()?.env ?? {})).toHaveLength(MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS)
    env.OVERFLOW = 'value'
    expect(inspectEnv()).toMatchObject({
      status: 'invalid',
      issue: 'Environment exceeds the MCP inspection field limits.'
    })
    expect(inspectEnv()?.env).toBeUndefined()
  })

  it('plans directory discovery before reading candidate files', () => {
    expect(getMcpConfigParentDirs()).toEqual(['.cursor', '.claude', '.gemini'])
    expect(
      MCP_CONFIG_CANDIDATES.map((candidate) => getMcpConfigCandidateParentDir(candidate))
    ).toEqual(['', '.cursor', '', '.claude', '.gemini'])

    const entriesByRelativeDir = new Map([
      [
        '',
        [
          { name: '.mcp.json', isDirectory: false },
          { name: '.cursor', isDirectory: true },
          { name: '.claude', isDirectory: false }
        ]
      ],
      ['.cursor', [{ name: 'mcp.json', isDirectory: false }]]
    ])

    expect(
      selectExistingMcpConfigCandidates(entriesByRelativeDir).map((entry) => entry.label)
    ).toEqual(['Workspace', 'Cursor'])
  })

  it('rejects Windows-only local roots on non-Windows hosts', () => {
    expect(canInspectLocalMcpConfigRoot('C:\\repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', false)).toBe(
      false
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('/Users/me/repo', false)).toBe(true)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', true)).toBe(
      true
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', true)).toBe(true)
  })
})

describe('omni-console default merge', () => {
  it('adds only the public HTTP endpoint and preserves unrelated configuration', () => {
    const custom = { type: 'stdio', command: 'my-server' }
    const config = { preferences: { theme: 'dark' }, mcpServers: { custom } }
    const merged = mergeOmniConsoleMcpConfig(config, true)
    expect(merged).toEqual({
      preferences: { theme: 'dark' },
      mcpServers: {
        custom,
        'omni-console': {
          type: 'http',
          url: OMNI_CONSOLE_MCP_URL,
          headers: {
            'X-Omni-Ledger-Session': '${OMNI_LEDGER_SESSION_ID:-}',
            'X-Omni-Ledger-Attempt': '${OMNI_LEDGER_ATTEMPT_ID:-}'
          }
        }
      }
    })
    expect(config.mcpServers).toEqual({ custom })
    expect(mergeOmniConsoleMcpConfig(merged, true)).toBe(merged)
  })

  it('adds the ledger headers to an endpoint-only entry it wrote earlier, once', () => {
    const config = { mcpServers: { 'omni-console': { type: 'http', url: OMNI_CONSOLE_MCP_URL } } }
    const upgraded = mergeOmniConsoleMcpConfig(config, true)
    expect(upgraded).toEqual({
      mcpServers: {
        'omni-console': {
          type: 'http',
          url: OMNI_CONSOLE_MCP_URL,
          headers: omniConsoleMcpLedgerHeaders('claude')
        }
      }
    })
    expect(mergeOmniConsoleMcpConfig(upgraded, true)).toBe(upgraded)
    const gemini = mergeOmniConsoleMcpConfig(
      { mcpServers: { 'omni-console': { httpUrl: OMNI_CONSOLE_MCP_URL } } },
      true,
      'gemini'
    )
    expect(gemini).toEqual({
      mcpServers: {
        'omni-console': {
          httpUrl: OMNI_CONSOLE_MCP_URL,
          headers: omniConsoleMcpLedgerHeaders('gemini')
        }
      }
    })
  })

  it('recognises only its own entry shapes as managed', () => {
    expect(isManagedOmniConsoleMcpEntry({ type: 'http', url: OMNI_CONSOLE_MCP_URL })).toBe(true)
    expect(isManagedOmniConsoleMcpEntry({ url: OMNI_CONSOLE_MCP_URL, enabled: true })).toBe(true)
    expect(
      isManagedOmniConsoleMcpEntry({
        url: OMNI_CONSOLE_MCP_URL,
        env_http_headers: omniConsoleMcpLedgerHeaders('codex')
      })
    ).toBe(true)
    expect(
      isManagedOmniConsoleMcpEntry({ url: OMNI_CONSOLE_MCP_URL, headers: { Authorization: 'x' } })
    ).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ url: OMNI_CONSOLE_MCP_URL, enabled: false })).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ url: 'https://custom.test/mcp' })).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ url: OMNI_CONSOLE_MCP_URL, command: 'x' })).toBe(false)
  })

  it.each([
    { mcpServers: { 'omni-console': { enabled: false } } },
    { mcpServers: { 'omni-console': { disabled: true } } },
    { mcpServers: { 'omni-console': { type: 'http', url: 'https://custom.test/mcp' } } },
    { disabledMcpServers: ['omni-console'] },
    { disabledMcpjsonServers: ['omni-console'] }
  ])('preserves an explicit server choice: %j', (config) => {
    expect(mergeOmniConsoleMcpConfig(config, true)).toBe(config)
  })

  it('does not add a server for a signed-out profile', () => {
    const config = { mcpServers: { custom: { command: 'custom' } } }
    expect(mergeOmniConsoleMcpConfig(config, false)).toBe(config)
  })

  it('refuses to replace an invalid server collection', () => {
    expect(() => mergeOmniConsoleMcpConfig({ mcpServers: [] }, true)).toThrow('object')
  })
})

describe('omni-console Claude headersHelper shape', () => {
  const HELPER = '/Applications/OmniConsole.app/Contents/Resources/mcp/omni-console-mcp-headers.sh'
  const helper = { claudeHeadersHelper: HELPER }
  const current = { type: 'http', url: OMNI_CONSOLE_MCP_URL, headersHelper: HELPER }
  const legacyTemplates = {
    type: 'http',
    url: OMNI_CONSOLE_MCP_URL,
    headers: {
      'X-Omni-Ledger-Session': '${OMNI_LEDGER_SESSION_ID:-}',
      'X-Omni-Ledger-Attempt': '${OMNI_LEDGER_ATTEMPT_ID:-}'
    }
  }
  const legacyLiteral = {
    type: 'http',
    url: OMNI_CONSOLE_MCP_URL,
    headers: {
      'X-Omni-Ledger-Session': 'als_aaaaaaaa',
      'X-Omni-Ledger-Attempt': 'att_11111111'
    }
  }
  const pinned = {
    type: 'http',
    url: OMNI_CONSOLE_MCP_URL,
    headers: { 'X-Omni-Client': 'claude-code' }
  }
  const withServer = (entry: unknown): Record<string, unknown> => ({
    mcpServers: { 'omni-console': entry }
  })

  it('writes the helper shape with no headers key for a new local Claude entry', () => {
    const merged = mergeOmniConsoleMcpConfig({}, true, 'claude', helper)
    expect(merged).toEqual(withServer(current))
    expect(
      Object.hasOwn((merged.mcpServers as Record<string, object>)['omni-console'], 'headers')
    ).toBe(false)
    expect(mergeOmniConsoleMcpConfig(merged, true, 'claude', helper)).toBe(merged)
  })

  it.each([
    ['legacy ledger headers as ${VAR:-} templates', legacyTemplates],
    ['legacy ledger headers with literal ids', legacyLiteral],
    ['endpoint-only entry', { type: 'http', url: OMNI_CONSOLE_MCP_URL }],
    [
      'our helper at an older install path',
      { ...current, headersHelper: '/old/Resources/mcp/omni-console-mcp-headers.sh' }
    ]
  ])('rewrites a managed %s to the helper shape on a local spawn, once', (_label, entry) => {
    const upgraded = mergeOmniConsoleMcpConfig(withServer(entry), true, 'claude', helper)
    expect(upgraded).toEqual(withServer(current))
    expect(mergeOmniConsoleMcpConfig(upgraded, true, 'claude', helper)).toBe(upgraded)
  })

  it.each([
    ['a pinned X-Omni-Client override', pinned],
    [
      'ledger headers plus another header',
      { ...legacyTemplates, headers: { ...legacyTemplates.headers, 'X-Omni-Client': 'x' } }
    ],
    ['a foreign URL', { type: 'http', url: 'https://custom.test/mcp' }],
    ['a foreign helper', { ...current, headersHelper: '/usr/local/bin/my-headers.sh' }],
    // F2: a user's wrapper around our helper is their own command, not our value.
    [
      'a wrapper around our helper',
      { ...current, headersHelper: `/usr/bin/env OMNI_LEDGER_SESSION_ID=als_custom ${HELPER}` }
    ],
    ['our helper with arguments', { ...current, headersHelper: `${HELPER} --extra` }],
    ['our helper followed by another command', { ...current, headersHelper: `${HELPER}; echo hi` }],
    ['a partially quoted helper', { ...current, headersHelper: `'${HELPER}' x` }],
    ['our helper plus static headers', { ...current, headers: { 'X-Omni-Client': 'x' } }]
  ])('never rewrites %s', (_label, entry) => {
    const config = withServer(entry)
    expect(mergeOmniConsoleMcpConfig(config, true, 'claude', helper)).toBe(config)
    expect(mergeOmniConsoleMcpConfig(config, true, 'claude')).toBe(config)
  })

  it('recognises the legacy managed and current shapes, and nothing else, as managed', () => {
    expect(isManagedOmniConsoleMcpEntry(current)).toBe(true)
    expect(isManagedOmniConsoleMcpEntry(legacyTemplates)).toBe(true)
    expect(isManagedOmniConsoleMcpEntry(legacyLiteral)).toBe(true)
    expect(isManagedOmniConsoleMcpEntry(pinned)).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ ...current, url: 'https://custom.test/mcp' })).toBe(false)
    expect(
      isManagedOmniConsoleMcpEntry({ ...current, headersHelper: 'omni-console-mcp-headers.sh' })
    ).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ ...current, headersHelper: 42 })).toBe(false)
    expect(isManagedOmniConsoleMcpEntry({ ...current, headers: {} })).toBe(false)
  })

  it('keeps the legacy shape and rule when no helper is offered (relay, WSL)', () => {
    expect(mergeOmniConsoleMcpConfig({}, true, 'claude')).toEqual(withServer(legacyTemplates))
    const legacy = withServer(legacyTemplates)
    expect(mergeOmniConsoleMcpConfig(legacy, true, 'claude')).toBe(legacy)
    // A helper entry written by a local spawn on this host is never downgraded or given headers.
    const helperEntry = withServer(current)
    expect(mergeOmniConsoleMcpConfig(helperEntry, true, 'claude')).toBe(helperEntry)
  })

  it('does not give Gemini the helper shape', () => {
    expect(mergeOmniConsoleMcpConfig({}, true, 'gemini', helper)).toEqual(
      withServer({ httpUrl: OMNI_CONSOLE_MCP_URL, headers: omniConsoleMcpLedgerHeaders('gemini') })
    )
  })

  it('shell-quotes a helper path with spaces and still recognises it', () => {
    const path =
      "/Users/maintainer/Library/Application Support/it's/mcp/omni-console-mcp-headers.sh"
    const command = omniConsoleMcpHeadersHelperCommand(path)
    expect(command).toBe(
      "'/Users/maintainer/Library/Application Support/it'\\''s/mcp/omni-console-mcp-headers.sh'"
    )
    expect(isOmniConsoleMcpHeadersHelperCommand(command)).toBe(true)
    expect(omniConsoleMcpHeadersHelperCommand(HELPER)).toBe(HELPER)
    expect(isOmniConsoleMcpHeadersHelperCommand(HELPER)).toBe(true)
    // A quoted value that hides a second command does not round-trip to our exact command.
    expect(
      isOmniConsoleMcpHeadersHelperCommand(
        "'/a/' ; touch /tmp/x ; '/mcp/omni-console-mcp-headers.sh'"
      )
    ).toBe(false)
  })
})

describe('OmniSI MCP endpoint', () => {
  it('exports the OmniSI endpoint beside the OmniConsole one', () => {
    expect(OMNISI_MCP_NAME).toBe('omnisi')
    expect(OMNISI_MCP_URL).toBe('https://app.omnisi.ai/mcp')
    expect(OMNICONSOLE_DEFAULT_MCP_ENDPOINTS).toEqual([
      { name: OMNI_CONSOLE_MCP_NAME, url: OMNI_CONSOLE_MCP_URL, label: 'OmniConsole MCP' },
      { name: OMNISI_MCP_NAME, url: OMNISI_MCP_URL, label: 'OmniSI Shared Tools MCP' }
    ])
  })

  it('finds the OmniSI server by name or by an alias on its URL', () => {
    expect(findOmniSiMcpName({})).toBeNull()
    expect(isOmniSiMcpConfigured({})).toBe(false)
    expect(findOmniSiMcpName({ mcpServers: { omnisi: { type: 'http', url: 'x' } } })).toBe('omnisi')
    expect(isOmniSiMcpConfigured({ mcpServers: { omnisi: { type: 'http', url: 'x' } } })).toBe(true)
    expect(
      findOmniSiMcpName({
        mcpServers: {
          [OMNI_CONSOLE_MCP_NAME]: { type: 'http', url: OMNI_CONSOLE_MCP_URL },
          team: { type: 'http', url: OMNISI_MCP_URL }
        }
      })
    ).toBe('team')
    expect(findOmniSiMcpName({ mcp_servers: { team: { url: OMNISI_MCP_URL } } }, true)).toBe('team')
    // A command server that happens to carry the URL is not the HTTP connector.
    expect(
      findOmniSiMcpName({ mcpServers: { team: { command: 'npx', url: OMNISI_MCP_URL } } })
    ).toBeNull()
  })

  it('keeps the OmniConsole and OmniSI managed-entry checks apart', () => {
    const omniSi = { type: 'http', url: OMNISI_MCP_URL }
    const omniConsole = { type: 'http', url: OMNI_CONSOLE_MCP_URL }
    expect(isManagedOmniSiMcpEntry(omniSi)).toBe(true)
    expect(isManagedOmniSiMcpEntry(omniConsole)).toBe(false)
    // The writer rewrites managed OmniConsole entries to its URL; an OmniSI entry must not match.
    expect(isManagedOmniConsoleMcpEntry(omniSi)).toBe(false)
    expect(isManagedOmniMcpEntry(omniSi)).toBe(true)
    expect(isManagedOmniMcpEntry(omniConsole)).toBe(true)
    expect(isManagedOmniMcpEntry({ type: 'http', url: OMNISI_MCP_URL, command: 'x' })).toBe(false)
  })
})
