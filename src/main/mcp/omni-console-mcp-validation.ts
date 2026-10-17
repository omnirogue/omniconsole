import { OMNI_CONSOLE_MCP_NAME, OMNI_CONSOLE_MCP_URL } from '../../shared/mcp-config'
import {
  findOmniConsoleMcpName,
  isOmniConsoleMcpNameUnavailable
} from '../../shared/omni-console-mcp-alias'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Preserve explicit settings, but never launch as though a blocked connector is available. */
export function hasLaunchableOmniConsoleMcp(
  config: Record<string, unknown>,
  toml = false
): boolean {
  const name = findOmniConsoleMcpName(config, toml) ?? OMNI_CONSOLE_MCP_NAME
  const collection = config[toml ? 'mcp_servers' : 'mcpServers']
  const servers = object(collection)
  if (collection !== undefined && !servers) {
    throw new Error('MCP server collection must be an object.')
  }
  const entry = servers?.[name]
  const server = object(entry)
  if (
    isOmniConsoleMcpNameUnavailable(config, name) ||
    (entry !== undefined &&
      (!server ||
        server.enabled === false ||
        server.disabled === true ||
        (server.httpUrl ?? server.url) !== OMNI_CONSOLE_MCP_URL ||
        server.command !== undefined))
  ) {
    throw new Error(
      'The omni-console MCP connector is disabled or overridden. Restore its omnios endpoint before launching this agent.'
    )
  }
  return entry !== undefined
}
