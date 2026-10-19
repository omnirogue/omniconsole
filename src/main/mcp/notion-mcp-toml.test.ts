import { describe, expect, it } from 'vitest'
import { NOTION_MCP_URL } from '../../shared/notion-mcp'
import { hasNotionMcpToml, mergeNotionMcpToml } from './notion-mcp-toml'

describe('providing Notion in a TOML config', () => {
  it('adds the connector to an empty config', () => {
    const merged = mergeNotionMcpToml('')

    expect(hasNotionMcpToml(merged)).toBe(true)
    expect(merged).toContain(NOTION_MCP_URL)
  })

  it('keeps a person comments, ordering and other servers by appending', () => {
    const existing =
      '# my notes\n[mcp_servers."omni-console"]\nurl = "https://console.example.com/mcp"\n'

    const merged = mergeNotionMcpToml(existing)

    expect(merged.startsWith(existing)).toBe(true)
    expect(hasNotionMcpToml(merged)).toBe(true)
  })

  it('never rewrites an entry someone already has under that name', () => {
    const theirs = '[mcp_servers."notion"]\nurl = "https://notion.internal.example/mcp"\n'

    expect(mergeNotionMcpToml(theirs)).toBe(theirs)
  })

  it('respects a disabled name', () => {
    const config = 'disabledMcpServers = ["notion"]\n'

    expect(mergeNotionMcpToml(config)).toBe(config)
  })

  it('is idempotent, so a relaunch rewrites nothing', () => {
    const first = mergeNotionMcpToml('')

    expect(mergeNotionMcpToml(first)).toBe(first)
  })

  it('falls back to a rewrite when the config cannot take an appended table', () => {
    // An inline table cannot be extended by appending [mcp_servers."notion"].
    const inline =
      'mcp_servers = { "omni-console" = { url = "https://console.example.com/mcp" } }\n'

    const merged = mergeNotionMcpToml(inline)

    expect(hasNotionMcpToml(merged)).toBe(true)
    expect(merged).toContain('omni-console')
  })

  it('refuses a server collection that is not a table rather than clobbering it', () => {
    expect(() => mergeNotionMcpToml('mcp_servers = 1\n')).toThrow(
      'MCP server collection must be a TOML table.'
    )
  })

  it('carries no credential', () => {
    expect(mergeNotionMcpToml('')).not.toMatch(/ntn_|secret|token|api[_-]?key/i)
  })
})
