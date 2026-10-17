import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentIcon, getAgentCatalog } from './agent-catalog'
import { MetaIcon } from './agent-icon-glyphs'
import {
  PROVIDER_ICON_LABELS,
  ProviderIcon,
  providerIconIdForMcpServer,
  providerIconIdForModel,
  type ProviderIconId
} from './provider-icon-catalog'
import type { TuiAgent } from '../../../shared/tui-agent'

describe('ProviderIcon', () => {
  it('renders a bundled inline glyph for every provider without a network source', () => {
    for (const id of Object.keys(PROVIDER_ICON_LABELS) as ProviderIconId[]) {
      const markup = renderToStaticMarkup(<ProviderIcon id={id} size={16} />)
      expect(markup, id).toContain('<svg')
      // Why: the SVG namespace attribute is a URI, not a fetch.
      expect(markup.replace(/xmlns="[^"]*"/g, ''), id).not.toMatch(/https?:\/\//)
      expect(markup, id).not.toContain('<img')
    }
  })

  it('maps MCP server names and models to brands, with a generic plug fallback', () => {
    expect(providerIconIdForMcpServer('github-mcp')).toBe('github')
    expect(providerIconIdForMcpServer('Linear')).toBe('linear')
    expect(providerIconIdForMcpServer('fal-ai')).toBe('fal')
    expect(providerIconIdForMcpServer('omni-console')).toBe('mcp')
    expect(providerIconIdForModel('openrouter/anthropic/claude')).toBe('openrouter')
    expect(providerIconIdForModel('gpt-5')).toBe('openai')
    expect(providerIconIdForModel('veo-3')).toBe('veo')
    expect(providerIconIdForModel('muse')).toBe('meta')
    expect(providerIconIdForModel('muse-spark-1.2')).toBe('meta')
    expect(providerIconIdForModel('muse-wonder-full-1.0')).toBe('meta')
    expect(providerIconIdForModel('ollama/llama3.1:8b')).toBeNull()
    expect(providerIconIdForModel('mystery')).toBeNull()
  })
})

describe('AgentIcon', () => {
  it('never falls back to a network favicon', () => {
    for (const entry of getAgentCatalog()) {
      const markup = renderToStaticMarkup(<AgentIcon agent={entry.id as TuiAgent} />)
      expect(markup, entry.id).not.toContain('google.com/s2/favicons')
    }
  })

  it('shows the Meta mark for Muse Code, not a letter', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="muse" />)
    expect(markup).toBe(renderToStaticMarkup(<MetaIcon />))
    expect(markup).not.toContain('<text')
  })
})
