import {
  OMNI_CONSOLE_MCP_NAME,
  OMNI_CONSOLE_MCP_URL,
  OMNIROGUE_MCP_NAME,
  OMNIROGUE_MCP_URL,
  OMNISI_MCP_NAME,
  OMNISI_MCP_URL,
  omniRogueUnifiedMcpDefaultEntry,
  type OmniConsoleMcpEntryOptions
} from './omni-console-mcp-ledger-headers'

export { OMNI_CONSOLE_MCP_NAME, OMNIROGUE_MCP_NAME, OMNISI_MCP_NAME }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function explicitlyDisabled(config: Record<string, unknown>, name: string): boolean {
  return [
    config.disabledMcpServers,
    config.disabledMcpjsonServers,
    config.disabled_mcp_servers,
    object(config.mcp)?.excluded
  ].some((names) => Array.isArray(names) && names.includes(name))
}

export function isOmniConsoleMcpNameUnavailable(
  config: Record<string, unknown>,
  name: string
): boolean {
  const allowed = object(config.mcp)?.allowed
  return explicitlyDisabled(config, name) || (Array.isArray(allowed) && !allowed.includes(name))
}

function findManagedMcpName(
  config: Record<string, unknown>,
  toml: boolean,
  defaultName: string,
  url: string
): string | null {
  const servers = object(config[toml ? 'mcp_servers' : 'mcpServers'])
  if ((servers && Object.hasOwn(servers, defaultName)) || explicitlyDisabled(config, defaultName)) {
    return defaultName
  }
  const aliases = Object.entries(servers ?? {}).filter(([, entry]) => {
    const server = object(entry)
    return (
      server &&
      (server.httpUrl ?? server.url) === url &&
      server.command === undefined &&
      (server.type === undefined || server.type === 'http' || server.type === 'streamable-http')
    )
  })
  const available = aliases.find(([name, entry]) => {
    const server = object(entry)!
    return (
      !isOmniConsoleMcpNameUnavailable(config, name) &&
      server.enabled !== false &&
      server.disabled !== true
    )
  })
  // A disabled alias still owns the endpoint; adding another entry would bypass it.
  return available?.[0] ?? aliases[0]?.[0] ?? null
}

/** Keep the provider's server name: OAuth credentials can be bound to it. */
export function findOmniConsoleMcpName(
  config: Record<string, unknown>,
  toml = false
): string | null {
  return findManagedMcpName(config, toml, OMNI_CONSOLE_MCP_NAME, OMNI_CONSOLE_MCP_URL)
}

/** The OmniSI Cloud server's name: `omnisi`, or an alias pointing at {@link OMNISI_MCP_URL}. */
export function findOmniSiMcpName(config: Record<string, unknown>, toml = false): string | null {
  return findManagedMcpName(config, toml, OMNISI_MCP_NAME, OMNISI_MCP_URL)
}

/** The OmniRogue Creative & Credits server's name: `omnirogue`, or an alias pointing at {@link OMNIROGUE_MCP_URL}. */
export function findOmniRogueMcpName(config: Record<string, unknown>, toml = false): string | null {
  return findManagedMcpName(config, toml, OMNIROGUE_MCP_NAME, OMNIROGUE_MCP_URL)
}

export function isOmniRogueMcpConfigured(config: Record<string, unknown>): boolean {
  return findOmniRogueMcpName(config) !== null
}

/**
 * Auto-provisions the unified OmniRogue & OmniSI MCP servers (`omnisi` + `omnirogue`) into a JSON
 * MCP config when an OmniRogue account is connected, preserving any existing user overrides.
 */
export function mergeOmniRogueUnifiedMcpConfig(
  config: Record<string, unknown>,
  connected: boolean,
  provider: 'claude' | 'gemini' | 'muse' = 'claude',
  options: OmniConsoleMcpEntryOptions = {}
): Record<string, unknown> {
  if (!connected) {
    return config
  }
  const servers = object(config.mcpServers)
  if (config.mcpServers !== undefined && !servers) {
    throw new Error('MCP server collection must be an object.')
  }
  const nextServers: Record<string, unknown> = { ...servers }
  let changed = false

  if (
    !findOmniSiMcpName(config) &&
    !isOmniConsoleMcpNameUnavailable(config, OMNISI_MCP_NAME)
  ) {
    nextServers[OMNISI_MCP_NAME] = omniRogueUnifiedMcpDefaultEntry(
      OMNISI_MCP_URL,
      provider,
      options
    )
    changed = true
  }

  if (
    !findOmniRogueMcpName(config) &&
    !isOmniConsoleMcpNameUnavailable(config, OMNIROGUE_MCP_NAME)
  ) {
    nextServers[OMNIROGUE_MCP_NAME] = omniRogueUnifiedMcpDefaultEntry(
      OMNIROGUE_MCP_URL,
      provider,
      options
    )
    changed = true
  }

  return changed ? { ...config, mcpServers: nextServers } : config
}
