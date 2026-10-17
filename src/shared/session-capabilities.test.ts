import { describe, expect, it } from 'vitest'
import {
  collectMcpServerNames,
  detectProviderKeyPresence,
  normalizeSessionCapabilities,
  probeSessionCapabilities,
  SESSION_CAPABILITY_MAX_MCP_SERVERS
} from './session-capabilities'
import { MCP_CONFIG_CANDIDATES } from './mcp-config'

const SECRET = 'fake-openrouter-value-never-shown'

describe('detectProviderKeyPresence', () => {
  it('reports env var names only, never their values', () => {
    const presence = detectProviderKeyPresence({
      OPENROUTER_API_KEY: SECRET,
      GOOGLE_APPLICATION_CREDENTIALS: '/home/me/vertex.json',
      FAL_KEY: '   ',
      PATH: '/usr/bin'
    })
    expect(presence).toEqual([
      { provider: 'openrouter', envNames: ['OPENROUTER_API_KEY'] },
      { provider: 'google', envNames: ['GOOGLE_APPLICATION_CREDENTIALS'] }
    ])
    expect(JSON.stringify(presence)).not.toContain(SECRET)
    expect(JSON.stringify(presence)).not.toContain('vertex.json')
  })

  it('treats keys the launch deletes as absent', () => {
    expect(
      detectProviderKeyPresence({ ANTHROPIC_API_KEY: 'x', XAI_API_KEY: 'y' }, ['ANTHROPIC_API_KEY'])
    ).toEqual([{ provider: 'xai', envNames: ['XAI_API_KEY'] }])
  })
})

describe('collectMcpServerNames', () => {
  it('keeps enabled server names, dedupes across files and drops env values', () => {
    const [workspace, cursor] = MCP_CONFIG_CANDIDATES
    const { names } = collectMcpServerNames([
      {
        candidate: workspace!,
        content: JSON.stringify({
          mcpServers: {
            github: { command: 'gh-mcp', env: { GITHUB_TOKEN: SECRET } },
            linear: { url: 'https://mcp.linear.app/sse', disabled: true }
          }
        })
      },
      {
        candidate: cursor!,
        content: JSON.stringify({
          mcpServers: { github: { command: 'x' }, slack: { url: 'u' } }
        })
      },
      { candidate: MCP_CONFIG_CANDIDATES[2]!, content: null }
    ])
    expect(names).toEqual([
      { name: 'github', source: 'Workspace' },
      { name: 'slack', source: 'Cursor' }
    ])
    expect(JSON.stringify(names)).not.toContain(SECRET)
  })

  it('marks the collection incomplete when a present source cannot be inspected', () => {
    const [workspace] = MCP_CONFIG_CANDIDATES
    expect(collectMcpServerNames([{ candidate: workspace!, content: '{not-json' }])).toEqual({
      names: [],
      incomplete: true
    })
    expect(collectMcpServerNames([{ candidate: workspace!, content: '' }]).incomplete).toBe(true)
    expect(collectMcpServerNames([{ candidate: workspace!, content: null }]).incomplete).toBe(false)
  })
})

describe('probeSessionCapabilities', () => {
  it('reports unknown for SSH sessions without reading local files or env', async () => {
    let reads = 0
    const result = await probeSessionCapabilities({
      cwd: '/remote/repo',
      env: { OPENAI_API_KEY: 'local-key' },
      connectionId: 'ssh-target-1',
      readCandidate: async () => {
        reads += 1
        return null
      },
      now: () => 5
    })
    expect(result).toEqual({
      host: 'remote',
      providers: 'unknown',
      mcpServers: 'unknown',
      probedAt: 5
    })
    expect(reads).toBe(0)
  })

  it('reads MCP candidates under the session cwd for local sessions', async () => {
    const requested: string[] = []
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: { ELEVENLABS_API_KEY: 'v' },
      readCandidate: async (cwd, candidate) => {
        requested.push(`${cwd}|${candidate.relativePath}`)
        return candidate.relativePath === '.mcp.json'
          ? '{"mcpServers":{"omni-console":{"url":"https://example.test/mcp"}}}'
          : null
      },
      now: () => 1
    })
    expect(requested).toContain('/repo|.mcp.json')
    expect(result.providers).toEqual([{ provider: 'elevenlabs', envNames: ['ELEVENLABS_API_KEY'] }])
    expect(result.mcpServers).toEqual([{ name: 'omni-console', source: 'Workspace' }])
  })

  it('reports unknown when one source answers and another is refused', async () => {
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async (_cwd, candidate) => {
        if (candidate.relativePath === '.mcp.json') {
          return '{"mcpServers":{"omni-console":{"url":"https://example.test/mcp"}}}'
        }
        throw new Error('EACCES')
      }
    })
    expect(result.mcpServers).toBe('unknown')
  })

  it('reports unknown when one source answers and another cannot be inspected', async () => {
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async (_cwd, candidate) =>
        candidate.relativePath === '.mcp.json'
          ? '{"mcpServers":{"known":{"command":"x"}}}'
          : candidate.relativePath === '.cursor/mcp.json'
            ? '{bad-json'
            : null
    })
    expect(result.mcpServers).toBe('unknown')
  })

  it('keeps checking source health past the display cap', async () => {
    const servers = Object.fromEntries(
      Array.from({ length: SESSION_CAPABILITY_MAX_MCP_SERVERS }, (_value, index) => [
        `server-${index}`,
        { command: 'x' }
      ])
    )
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async (_cwd, candidate) =>
        candidate.relativePath === '.mcp.json'
          ? JSON.stringify({ mcpServers: servers })
          : candidate.relativePath === '.cursor/mcp.json'
            ? '{bad-json'
            : null
    })
    expect(result.mcpServers).toBe('unknown')
  })

  it('reports unknown, not empty, when every MCP source is unreadable', async () => {
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async () => {
        throw new Error('EACCES')
      },
      now: () => 2
    })
    expect(result.mcpServers).toBe('unknown')
  })

  it('reports unknown when a source exists but cannot be inspected', async () => {
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async (_cwd, candidate) =>
        candidate.relativePath === '.mcp.json' ? '{not-json' : null
    })
    expect(result.mcpServers).toBe('unknown')
  })

  it('reports an empty list when every MCP source is simply absent', async () => {
    const result = await probeSessionCapabilities({
      cwd: '/repo',
      env: {},
      readCandidate: async () => null
    })
    expect(result.mcpServers).toEqual([])
  })

  it('leaves MCP unknown when the cwd is not known', async () => {
    const result = await probeSessionCapabilities({
      cwd: undefined,
      env: {},
      readCandidate: async () => null
    })
    expect(result.mcpServers).toBe('unknown')
    expect(result.providers).toEqual([])
  })
})

describe('normalizeSessionCapabilities', () => {
  it('rejects malformed replies and drops unknown providers', () => {
    expect(normalizeSessionCapabilities(null)).toBeNull()
    expect(normalizeSessionCapabilities({ host: 'mars' })).toBeNull()
    expect(
      normalizeSessionCapabilities({
        host: 'local',
        providers: [
          { provider: 'openai', envNames: ['OPENAI_API_KEY', 7] },
          { provider: 'evil', envNames: [] }
        ],
        mcpServers: [{ name: 'github', source: 'Workspace' }, { name: 3 }],
        probedAt: 9
      })
    ).toEqual({
      host: 'local',
      providers: [{ provider: 'openai', envNames: ['OPENAI_API_KEY'] }],
      mcpServers: [{ name: 'github', source: 'Workspace' }],
      probedAt: 9
    })
  })
})
