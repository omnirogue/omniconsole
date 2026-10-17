/**
 * Notion as a connector every agent gets, the same way the console one is provided.
 *
 * The hosted Notion server authenticates per person in a browser, so shipping the entry gives
 * someone the tool without giving them anyone else's access: what they can see in Notion follows
 * from their own grants, never from whose agent is running. That is the same rule the estate
 * already applies to Jira accounts.
 *
 * Nothing here carries a credential. The entry is a URL; the sign-in happens on first use.
 */

import { isOmniConsoleMcpNameUnavailable } from './omni-console-mcp-alias'

export const NOTION_MCP_NAME = 'notion'
export const NOTION_MCP_URL = 'https://mcp.notion.com/mcp'

export type NotionMcpConfigStyle = 'claude' | 'gemini'

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function notionMcpDefaultEntry(style: NotionMcpConfigStyle): Record<string, unknown> {
  // Gemini names the field httpUrl; the others take a type + url pair.
  return style === 'gemini' ? { httpUrl: NOTION_MCP_URL } : { type: 'http', url: NOTION_MCP_URL }
}

/**
 * Adds the connector when the config has no server under that name.
 *
 * Deliberately conservative: ANY existing `notion` entry is left exactly as it is, even one that
 * looks like ours. Someone may point that name at their own proxy, a self-hosted server or a
 * different workspace, and quietly rewriting it would take their access away. Returns the same
 * object when nothing changed, so a caller can compare by reference and skip the write.
 */
export function mergeNotionMcpConfig(
  config: Record<string, unknown>,
  style: NotionMcpConfigStyle = 'claude'
): Record<string, unknown> {
  const servers = object(config.mcpServers)
  if (config.mcpServers !== undefined && !servers) {
    throw new Error('MCP server collection must be an object.')
  }
  if (servers?.[NOTION_MCP_NAME] !== undefined) {
    return config
  }
  // Honours the same opt-out lists the console connector honours: a name someone disabled, or
  // an allow-list that does not name it, means they said no.
  if (isOmniConsoleMcpNameUnavailable(config, NOTION_MCP_NAME)) {
    return config
  }
  return {
    ...config,
    mcpServers: { ...servers, [NOTION_MCP_NAME]: notionMcpDefaultEntry(style) }
  }
}
