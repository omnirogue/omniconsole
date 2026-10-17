import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import {
  isManagedOmniConsoleMcpEntry,
  OMNI_CONSOLE_MCP_NAME,
  OMNI_CONSOLE_MCP_URL,
  OMNIROGUE_MCP_NAME,
  OMNIROGUE_MCP_URL,
  OMNISI_MCP_NAME,
  OMNISI_MCP_URL,
  omniConsoleMcpEntryNeedsLedgerHeaders,
  omniConsoleMcpHeadersKey,
  omniConsoleMcpLedgerHeaders
} from '../../shared/mcp-config'
import { hasLaunchableOmniConsoleMcp } from './omni-console-mcp-validation'
import {
  findOmniConsoleMcpName,
  findOmniRogueMcpName,
  findOmniSiMcpName,
  isOmniConsoleMcpNameUnavailable
} from '../../shared/omni-console-mcp-alias'

export type OmniConsoleMcpTomlProvider = 'codex' | 'grok'

// Why: smol-toml provides CJS at runtime but ESM-only declarations. Keep a static require
// so the CommonJS CLI uses that export and self-contained relay bundles embed the parser.
const { parse, stringify } = require('smol-toml') as typeof SmolToml
type TomlTable = SmolToml.TomlTable

function servers(config: TomlTable): TomlTable {
  const value = config.mcp_servers
  if (value === undefined) {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP server collection must be a TOML table.')
  }
  return value as TomlTable
}

/** Our shipped shape: the endpoint alone, or the endpoint plus the ledger headers. */
function isDefault(server: unknown): boolean {
  return isManagedOmniConsoleMcpEntry(server)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function ledgerHeadersTable(provider: OmniConsoleMcpTomlProvider, name: string): string {
  const key = omniConsoleMcpHeadersKey(provider)
  const lines = Object.entries(omniConsoleMcpLedgerHeaders(provider)).map(
    ([headerName, value]) => `${tomlString(headerName)} = ${tomlString(value)}`
  )
  return `[mcp_servers.${tomlString(name)}.${key}]\n${lines.join('\n')}\n`
}

export function hasOmniConsoleMcpToml(config: string): boolean {
  const parsed = parse(config)
  servers(parsed)
  return findOmniConsoleMcpName(parsed, true) !== null
}

export function hasOmniRogueUnifiedMcpToml(config: string): boolean {
  const parsed = parse(config)
  servers(parsed)
  return findOmniSiMcpName(parsed, true) !== null && findOmniRogueMcpName(parsed, true) !== null
}

export function hasLaunchableOmniConsoleMcpToml(config: string): boolean {
  return hasLaunchableOmniConsoleMcp(parse(config), true)
}

export function isOmniConsoleDefaultToml(config: string): boolean {
  const parsed = parse(config)
  const name = findOmniConsoleMcpName(parsed, true) ?? OMNI_CONSOLE_MCP_NAME
  return isDefault(servers(parsed)[name])
}

/** An entry this app wrote before the ledger headers existed. */
export function omniConsoleMcpTomlNeedsLedgerHeaders(
  config: string,
  provider: OmniConsoleMcpTomlProvider
): boolean {
  const parsed = parse(config)
  const name = findOmniConsoleMcpName(parsed, true) ?? OMNI_CONSOLE_MCP_NAME
  return omniConsoleMcpEntryNeedsLedgerHeaders(servers(parsed)[name], provider)
}

/** A managed-home refresh must not replace a user's override with our shipped default. */
export function preserveOmniConsoleRuntimeOverride(runtime: string, system: string): string {
  const target = parse(system)
  const source = servers(target)
  const name = findOmniConsoleMcpName(target, true) ?? OMNI_CONSOLE_MCP_NAME
  if (!isDefault(source[name])) {
    return system
  }
  const overrides = servers(parse(runtime))
  if (!Object.hasOwn(overrides, name) || isDefault(overrides[name])) {
    return system
  }
  return stringify({
    ...target,
    mcp_servers: { ...source, [name]: overrides[name] }
  })
}

export function mergeOmniConsoleMcpToml(
  config: string,
  signedIn: boolean,
  provider: OmniConsoleMcpTomlProvider = 'codex'
): string {
  if (!signedIn) {
    return config
  }
  const parsed = parse(config)
  const entries = servers(parsed)
  const name = findOmniConsoleMcpName(parsed, true) ?? OMNI_CONSOLE_MCP_NAME
  const headersKey = omniConsoleMcpHeadersKey(provider)
  const headers = omniConsoleMcpLedgerHeaders(provider)
  const separator = config.endsWith('\n') || !config ? '' : '\n'
  if (findOmniConsoleMcpName(parsed, true)) {
    if (isOmniConsoleMcpNameUnavailable(parsed, name)) {
      return config
    }
    const existing = entries[name]
    if (!omniConsoleMcpEntryNeedsLedgerHeaders(existing, provider)) {
      return config
    }
    // Why: an endpoint-only entry this app wrote earlier gains the ledger headers once.
    const upgraded = `${config}${separator}\n${ledgerHeadersTable(provider, name)}`
    try {
      const check = servers(parse(upgraded))[name] as TomlTable
      if (isDefault(check) && !omniConsoleMcpEntryNeedsLedgerHeaders(check, provider)) {
        return upgraded
      }
    } catch {
      // fall through to a structural rewrite
    }
    return stringify({
      ...parsed,
      mcp_servers: {
        ...entries,
        [name]: { ...(existing as TomlTable), [headersKey]: headers }
      }
    })
  }
  const appended = `${config}${separator}\n[mcp_servers.${tomlString(name)}]\nurl = "${OMNI_CONSOLE_MCP_URL}"\n\n${ledgerHeadersTable(provider, name)}`
  try {
    parse(appended)
    return appended
  } catch {
    // Inline collections cannot be extended by appending another TOML table.
    return stringify({
      ...parsed,
      mcp_servers: {
        ...entries,
        [name]: { url: OMNI_CONSOLE_MCP_URL, [headersKey]: headers }
      }
    })
  }
}

function mergeNamedEndpointToml(
  config: string,
  defaultName: string,
  url: string,
  findExistingName: (parsed: Record<string, unknown>, isToml: boolean) => string | null,
  provider: OmniConsoleMcpTomlProvider
): string {
  const parsed = parse(config)
  const entries = servers(parsed)
  const existingName = findExistingName(parsed, true)
  if (existingName) {
    return config
  }
  if (isOmniConsoleMcpNameUnavailable(parsed, defaultName)) {
    return config
  }
  const headersKey = omniConsoleMcpHeadersKey(provider)
  const headers = omniConsoleMcpLedgerHeaders(provider)
  const separator = config.endsWith('\n') || !config ? '' : '\n'
  const appended = `${config}${separator}\n[mcp_servers.${tomlString(defaultName)}]\nurl = "${url}"\n\n${ledgerHeadersTable(provider, defaultName)}`
  try {
    parse(appended)
    return appended
  } catch {
    return stringify({
      ...parsed,
      mcp_servers: {
        ...entries,
        [defaultName]: { url, [headersKey]: headers }
      }
    })
  }
}

export function mergeOmniRogueUnifiedMcpToml(
  config: string,
  connected: boolean,
  provider: OmniConsoleMcpTomlProvider = 'codex'
): string {
  if (!connected) {
    return config
  }
  const withOmniSi = mergeNamedEndpointToml(
    config,
    OMNISI_MCP_NAME,
    OMNISI_MCP_URL,
    findOmniSiMcpName,
    provider
  )
  return mergeNamedEndpointToml(
    withOmniSi,
    OMNIROGUE_MCP_NAME,
    OMNIROGUE_MCP_URL,
    findOmniRogueMcpName,
    provider
  )
}

