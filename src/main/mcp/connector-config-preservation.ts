import { readFileSync, mkdirSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { validateConnectorName } from '../../shared/mcp-connectors'

const { parse, stringify } = require('smol-toml') as typeof SmolToml
const MARKER = '.omni-mcp-account-overrides.json'
type Overrides = Record<string, 'keep' | 'remove'>

function readOverrides(home: string): Overrides {
  try {
    const text = readFileSync(join(home, MARKER), 'utf8')
    if (text.length > 64 * 1024) {
      throw new Error('Connector account preferences are too large.')
    }
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid connector account preferences.')
    }
    for (const [name, action] of Object.entries(value)) {
      validateConnectorName(name)
      if (action !== 'keep' && action !== 'remove') {
        throw new Error('Invalid connector account preference.')
      }
    }
    return value as Overrides
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export function rememberConnectorChoice(
  home: string,
  name: string,
  action: 'keep' | 'remove'
): void {
  validateConnectorName(name)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileAtomically(
    join(home, MARKER),
    JSON.stringify({ ...readOverrides(home), [name]: action }),
    { mode: 0o600 }
  )
}

/** Account choices survive canonical config refreshes without promoting them to other accounts. */
export function preserveAccountConnectorConfig(
  home: string,
  runtime: string,
  system: string
): string {
  const overrides = readOverrides(home)
  if (!Object.keys(overrides).length) {
    return system
  }
  const source = parse(runtime)
  const target = parse(system)
  const runtimeServers = source.mcp_servers as SmolToml.TomlTable | undefined
  const targetServers = { ...(target.mcp_servers as SmolToml.TomlTable | undefined) }
  for (const [name, action] of Object.entries(overrides)) {
    if (action === 'remove') {
      // A disabled tombstone also prevents automatic built-in connector provisioning.
      targetServers[name] = { enabled: false, command: 'omni-connector-removed' }
    } else if (runtimeServers?.[name] !== undefined) {
      targetServers[name] = runtimeServers[name]
    }
  }
  return stringify({ ...target, mcp_servers: targetServers })
}

export function persistRemovedConnector(
  home: string,
  provider: 'claude' | 'codex',
  file: string,
  name: string
): void {
  const text = readFileSync(file, 'utf8')
  if (provider === 'codex') {
    writeFileAtomically(file, preserveAccountConnectorConfig(home, text, text), { mode: 0o600 })
  } else {
    const config = JSON.parse(text)
    const disabled: string[] = Array.isArray(config.disabledMcpServers)
      ? config.disabledMcpServers
      : []
    config.disabledMcpServers = [...new Set([...disabled, name])]
    writeFileAtomically(file, JSON.stringify(config, null, 2), { mode: 0o600 })
  }
}

export function restoreClaudeConnectorChoice(file: string, name: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(config.disabledMcpServers) || !config.disabledMcpServers.includes(name)) {
    return
  }
  config.disabledMcpServers = config.disabledMcpServers.filter((value: unknown) => value !== name)
  writeFileAtomically(file, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** Only the reserved team entry is ours; unrelated servers and the internal MCP stay intact. */
export function updateTeamConnectorConfig(
  file: string,
  provider: 'claude' | 'codex' | 'gemini' | 'grok',
  server: string | null
): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    file = realpathSync(file)
  }
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (previous === null && server === null) {
    return
  }
  if (previous && previous.length > 2 * 1024 * 1024) {
    throw new Error('MCP configuration is too large.')
  }
  const toml = provider === 'codex' || provider === 'grok'
  const config = previous === null ? {} : toml ? parse(previous) : JSON.parse(previous)
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid MCP configuration.')
  }
  const collection = toml ? 'mcp_servers' : 'mcpServers'
  const servers = config[collection] ?? {}
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Invalid MCP servers.')
  }
  const name = 'omnisi-team'
  const authorization =
    provider === 'codex'
      ? { env_http_headers: { Authorization: 'OMNICONSOLE_OMNISI_AUTHORIZATION' } }
      : { headers: { Authorization: '${OMNICONSOLE_OMNISI_AUTHORIZATION}' } }
  const entry = {
    ...(provider === 'claude' ? { type: 'http' } : {}),
    [provider === 'gemini' ? 'httpUrl' : 'url']: server,
    ...authorization
  }
  const existing = servers[name]
  const managed =
    existing &&
    JSON.stringify(existing[provider === 'codex' ? 'env_http_headers' : 'headers']) ===
      JSON.stringify(authorization[provider === 'codex' ? 'env_http_headers' : 'headers'])
  if (existing && !managed) {
    throw new Error('The omnisi-team connector name is already in use.')
  }
  if (server === null) {
    if (!existing) {
      return
    }
    delete servers[name]
  } else {
    if (JSON.stringify(existing) === JSON.stringify(entry)) {
      return
    }
    servers[name] = entry
  }
  config[collection] = servers
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (
    !writeFileAtomicallyIfUnchanged(
      file,
      previous,
      toml ? stringify(config) : JSON.stringify(config, null, 2),
      { mode: 0o600 }
    )
  ) {
    throw new Error('MCP configuration changed. Retry the team connection.')
  }
}

export function forgetTeamConnectorChoice(home: string): void {
  const overrides = readOverrides(home)
  if (!('omnisi-team' in overrides)) {
    return
  }
  delete overrides['omnisi-team']
  if (Object.keys(overrides).length) {
    writeFileAtomically(join(home, MARKER), JSON.stringify(overrides), { mode: 0o600 })
  } else {
    unlinkSync(join(home, MARKER))
  }
}
