import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

const { createOmniSiMcpCatalogSearch } = await import('./omnirogue-mcp-catalog-ipc')

const TOKEN = 'or_obp_test'
const tools = [
  { name: 'media_generate', title: 'Generate media', inputSchema: { properties: { prompt: {} } } },
  { name: 'credits_balance', description: 'Read the wallet' },
  { name: 'tools_search', inputSchema: [] }
]

function server() {
  const calls: { body: Record<string, unknown>; headers: Headers }[] = []
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ body, headers: new Headers(init?.headers) })
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' }
      })
    if (body.method === 'initialize') {
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    }
    if (body.method === 'tools/list') {
      return reply({ tools })
    }
    return new Response(null, { status: 202 })
  })
  return { calls, fetcher: fetcher as unknown as typeof fetch }
}

describe('createOmniSiMcpCatalogSearch', () => {
  it('lists the catalog over an authenticated MCP session and caches it', async () => {
    const { calls, fetcher } = server()
    const search = createOmniSiMcpCatalogSearch({
      leaseToken: async () => TOKEN,
      fetcher,
      url: 'https://omnisi.test/mcp'
    })
    const first = await search({ query: '' })
    expect(first.total).toBe(3)
    expect(first.tools.map((tool) => tool.name)).toEqual([
      'media_generate',
      'credits_balance',
      'tools_search'
    ])
    // Non-object schemas are dropped rather than passed to the renderer.
    expect(first.tools[2]).toEqual({ name: 'tools_search' })
    expect(calls.every(({ headers }) => headers.get('Authorization') === `Bearer ${TOKEN}`)).toBe(
      true
    )
    expect(calls.at(-1)?.headers.get('Mcp-Session-Id')).toBe('session-1')
    const listed = calls.length
    await search({ query: 'credits' })
    expect(calls).toHaveLength(listed)
    await search({ query: '', refresh: true })
    expect(calls.length).toBeGreaterThan(listed)
  })

  it('ranks queries with the catalog search', async () => {
    const { fetcher } = server()
    const search = createOmniSiMcpCatalogSearch({ leaseToken: async () => TOKEN, fetcher })
    const result = await search({ query: 'prompt' })
    expect(result).toEqual({
      tools: [expect.objectContaining({ name: 'media_generate' })],
      total: 3
    })
  })

  it('asks for an account before calling the server', async () => {
    const { fetcher } = server()
    const search = createOmniSiMcpCatalogSearch({ leaseToken: async () => null, fetcher })
    await expect(search({ query: '' })).rejects.toThrow('Connect your OmniRogue account')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports HTTP failures without caching them', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 503 }))
    const search = createOmniSiMcpCatalogSearch({
      leaseToken: async () => TOKEN,
      fetcher: fetcher as unknown as typeof fetch
    })
    await expect(search({})).rejects.toThrow('HTTP 503')
    await expect(search({})).rejects.toThrow('HTTP 503')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
