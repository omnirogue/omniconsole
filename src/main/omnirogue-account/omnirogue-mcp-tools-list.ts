import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_PAGES = 20
const PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18']

/** Sends one JSON-RPC body to the MCP endpoint with the session headers gathered so far. */
export type McpPost = (body: unknown, headers: Record<string, string>) => Promise<Response>

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function ensure(condition: unknown, invalid: () => Error): asserts condition {
  if (!condition) {
    throw invalid()
  }
}

/** Reads the reply with `id` from a JSON or event-stream response; `invalid` builds the caller's error. */
export async function readMcpRpcResult(
  response: Response,
  id: number,
  invalid: () => Error
): Promise<Record<string, unknown>> {
  let value: unknown
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body?.getReader()
    ensure(reader, invalid)
    const decoder = new TextDecoder()
    let pending = '',
      bytes = 0
    try {
      while (value === undefined) {
        const chunk = await reader.read()
        ensure(!chunk.done, invalid)
        bytes += chunk.value.byteLength
        ensure(bytes <= MAX_BYTES, invalid)
        pending += decoder.decode(chunk.value, { stream: true })
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const event = pending.slice(0, boundary.index)
          pending = pending.slice(boundary.index + boundary[0].length)
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
          if (!data) {
            continue
          }
          const message: unknown = JSON.parse(data)
          if (record(message).id === id) {
            value = message
            break
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  } else {
    value = await readFetchResponseJsonWithinLimit(response, MAX_BYTES)
  }
  const message = record(value)
  ensure(
    message.jsonrpc === '2.0' && message.id === id && !message.error && message.result,
    invalid
  )
  return record(message.result)
}

/** Opens a streamable-HTTP MCP session and returns every tool `tools/list` pages through. */
export async function listMcpTools(
  post: McpPost,
  clientName: string,
  invalid: () => Error
): Promise<Record<string, unknown>[]> {
  let id = 0
  const headers: Record<string, string> = {}
  async function rpc(method: string, params: unknown) {
    const requestId = ++id
    const response = await post({ jsonrpc: '2.0', id: requestId, method, params }, headers)
    const result = await readMcpRpcResult(response, requestId, invalid)
    const session = response.headers.get('mcp-session-id')
    if (method === 'initialize' && session) {
      headers['Mcp-Session-Id'] = session
    }
    return result
  }
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' }
  })
  ensure(PROTOCOL_VERSIONS.includes(String(init.protocolVersion)), invalid)
  ensure(record(init.capabilities).tools, invalid)
  headers['MCP-Protocol-Version'] = String(init.protocolVersion)
  const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)
  void notified.body?.cancel().catch(() => undefined)
  const tools: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc('tools/list', cursor ? { cursor } : {})
    ensure(Array.isArray(result.tools), invalid)
    for (const tool of result.tools as unknown[]) {
      ensure(typeof record(tool).name === 'string', invalid)
      tools.push(record(tool))
    }
    if (result.nextCursor === undefined) {
      break
    }
    ensure(typeof result.nextCursor === 'string' && result.nextCursor, invalid)
    ensure(!cursors.has(result.nextCursor as string) && page < MAX_PAGES - 1, invalid)
    cursor = result.nextCursor as string
    cursors.add(cursor)
  }
  return tools
}
