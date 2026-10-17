import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import { writeFileAtomically } from '../codex-accounts/fs-utils'
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
