import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import { isOmniConsoleMcpNameUnavailable } from '../../shared/omni-console-mcp-alias'
import { NOTION_MCP_NAME, NOTION_MCP_URL } from '../../shared/notion-mcp'

// Why the static require: smol-toml ships CJS at runtime with ESM-only declarations, and the
// CommonJS CLI and the self-contained relay bundles both have to embed this parser.
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

/**
 * Provides Notion in the TOML configs (Codex, Grok), matching the JSON side.
 *
 * Same two refusals as the JSON merge: any existing entry under that name is left exactly as it
 * is, because it may point at a proxy or another workspace, and a disabled name or an allow-list
 * without it means no. Returns its input unchanged when there is nothing to add.
 *
 * Appending a table is preferred over re-serializing, so a person's comments, ordering and
 * formatting survive. Re-serializing is the fallback for a config whose inline collections make
 * an appended table unparseable, which is the same strategy the console connector uses.
 */
export function mergeNotionMcpToml(config: string): string {
  const parsed = parse(config)
  const entries = servers(parsed)
  if (entries[NOTION_MCP_NAME] !== undefined) {
    return config
  }
  if (isOmniConsoleMcpNameUnavailable(parsed, NOTION_MCP_NAME)) {
    return config
  }
  const separator = config.endsWith('\n') || !config ? '' : '\n'
  const appended = `${config}${separator}\n[mcp_servers.${JSON.stringify(NOTION_MCP_NAME)}]\nurl = ${JSON.stringify(NOTION_MCP_URL)}\n`
  try {
    if (servers(parse(appended))[NOTION_MCP_NAME] !== undefined) {
      return appended
    }
  } catch {
    // fall through to a structural rewrite
  }
  return stringify({
    ...parsed,
    mcp_servers: { ...entries, [NOTION_MCP_NAME]: { url: NOTION_MCP_URL } }
  })
}

export function hasNotionMcpToml(config: string): boolean {
  return servers(parse(config))[NOTION_MCP_NAME] !== undefined
}
