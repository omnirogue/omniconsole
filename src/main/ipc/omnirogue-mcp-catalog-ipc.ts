import { ipcMain } from 'electron'
import { OMNISI_MCP_URL } from '../../shared/omni-console-mcp-ledger-headers'
import {
  searchOmniRogueMcpCatalog,
  type OmniRogueMcpCatalogTool
} from '../mcp/omnirogue-mcp-catalog-search'
import { getSharedOmniRogueAccountLease } from '../omnirogue-account/omnirogue-account-lease'
import { listMcpTools } from '../omnirogue-account/omnirogue-mcp-tools-list'

const CATALOG_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const SEARCH_LIMIT = 100
const MAX_QUERY_LENGTH = 200

export type OmniSiMcpCatalogDeps = {
  leaseToken: () => Promise<string | null>
  fetcher?: typeof fetch
  url?: string
  now?: () => number
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

function toCatalogTool(raw: Record<string, unknown>): OmniRogueMcpCatalogTool {
  const schema = raw.inputSchema
  return {
    name: String(raw.name),
    ...(text(raw.title) ? { title: text(raw.title) } : {}),
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    ...(schema && typeof schema === 'object' && !Array.isArray(schema)
      ? { inputSchema: schema as Record<string, unknown> }
      : {})
  }
}

/** Lists the OmniSI MCP catalog once per TTL and ranks it with the W5-41 metadata search. */
export function createOmniSiMcpCatalogSearch(deps: OmniSiMcpCatalogDeps) {
  const now = deps.now ?? Date.now
  let cached: { at: number; tools: OmniRogueMcpCatalogTool[] } | null = null
  let inFlight: Promise<OmniRogueMcpCatalogTool[]> | null = null

  async function load(): Promise<OmniRogueMcpCatalogTool[]> {
    const token = await deps.leaseToken()
    if (!token) {
      throw new Error('Connect your OmniRogue account to browse OmniSI tools.')
    }
    const url = deps.url ?? OMNISI_MCP_URL
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const raw = await listMcpTools(
      async (body, headers) => {
        const response = await (deps.fetcher ?? fetch)(url, {
          method: 'POST',
          signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...headers
          },
          body: JSON.stringify(body)
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error(`The OmniSI MCP server answered HTTP ${response.status}.`)
        }
        return response
      },
      'omniconsole-mcp-explorer',
      () => new Error('The OmniSI MCP server returned an invalid response.')
    )
    return raw.map(toCatalogTool)
  }

  async function catalog(refresh: boolean): Promise<OmniRogueMcpCatalogTool[]> {
    if (!refresh && cached && now() - cached.at < CATALOG_TTL_MS) {
      return cached.tools
    }
    inFlight ??= load()
      .then((tools) => {
        cached = { at: now(), tools }
        return tools
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return async (args: unknown): Promise<{ tools: OmniRogueMcpCatalogTool[]; total: number }> => {
    const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    const query = typeof input.query === 'string' ? input.query.slice(0, MAX_QUERY_LENGTH) : ''
    const tools = await catalog(input.refresh === true)
    return {
      tools: query.trim() ? searchOmniRogueMcpCatalog(tools, query, SEARCH_LIMIT) : tools,
      total: tools.length
    }
  }
}

export function registerOmniRogueMcpCatalogIpc(
  deps: OmniSiMcpCatalogDeps = {
    leaseToken: () => getSharedOmniRogueAccountLease().leaseToken()
  }
): void {
  const search = createOmniSiMcpCatalogSearch(deps)
  ipcMain.removeHandler('omnirogue:mcp:search-omnisi-tools')
  ipcMain.handle('omnirogue:mcp:search-omnisi-tools', (_event, args: unknown) => search(args))
}
