import { describe, expect, it } from 'vitest'
import {
  mergeNotionMcpConfig,
  notionMcpDefaultEntry,
  NOTION_MCP_NAME,
  NOTION_MCP_URL
} from './notion-mcp'

describe('providing Notion to every agent', () => {
  it('adds the connector when the config has none', () => {
    const merged = mergeNotionMcpConfig({})

    expect(merged.mcpServers).toEqual({
      [NOTION_MCP_NAME]: { type: 'http', url: NOTION_MCP_URL }
    })
  })

  it('keeps the servers already configured', () => {
    const merged = mergeNotionMcpConfig({
      mcpServers: { 'omni-console': { type: 'http', url: 'https://console.example.com/mcp' } }
    })

    expect(Object.keys(merged.mcpServers as object).sort()).toEqual(['notion', 'omni-console'])
  })

  it('names the field the way Gemini reads it', () => {
    expect(notionMcpDefaultEntry('gemini')).toEqual({ httpUrl: NOTION_MCP_URL })
  })

  it('never rewrites an entry someone already has under that name', () => {
    // It may point at their own proxy, a self-hosted server or another workspace. Rewriting it
    // would take their access away, which is worse than not providing ours.
    const theirs = { type: 'http', url: 'https://notion.internal.example/mcp', headers: { A: '1' } }
    const config = { mcpServers: { notion: theirs } }

    const merged = mergeNotionMcpConfig(config)

    expect(merged).toBe(config)
    expect((merged.mcpServers as Record<string, unknown>).notion).toBe(theirs)
  })

  it('respects a name someone disabled', () => {
    const config = { disabledMcpServers: ['notion'] }

    expect(mergeNotionMcpConfig(config)).toBe(config)
  })

  it('respects an allow-list that does not name it', () => {
    const config = { mcp: { allowed: ['omni-console'] } }

    expect(mergeNotionMcpConfig(config)).toBe(config)
  })

  it('is idempotent, so a relaunch rewrites nothing', () => {
    const first = mergeNotionMcpConfig({})

    expect(mergeNotionMcpConfig(first)).toBe(first)
  })

  it('refuses a server collection that is not an object rather than clobbering it', () => {
    expect(() => mergeNotionMcpConfig({ mcpServers: [] })).toThrow(
      'MCP server collection must be an object.'
    )
  })

  it('carries no credential: the entry is a URL and the person signs in themselves', () => {
    const entry = notionMcpDefaultEntry('claude')

    expect(JSON.stringify(entry)).not.toMatch(/ntn_|secret|token|key/i)
  })
})
