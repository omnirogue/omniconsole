import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'

export type JsonObject = Record<string, unknown>

export type Scope = {
  company?: string
  domain?: string
  grant_id?: string
  job_id?: string
  task_id?: string
}

export type OmniMcpSession = {
  accessToken: string
  organizationId: string
  /** Reject if the selected account, organization or sign-in lifecycle changed. */
  assertCurrent: () => void
}

export type OmniMcpParityClientOptions = {
  organizationId: string
  getSession: (signal: AbortSignal) => Promise<OmniMcpSession | null>
  fetcher?: typeof fetch
  timeoutMs?: number
}

export type OmniMcpToolResult = JsonObject & {
  content: (JsonObject & { type: string })[]
  structuredContent?: JsonObject
  isError?: boolean
}

export type OmniMcpInvoke = Scope & {
  capability: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path?: string
  query?: JsonObject
  body?: unknown
  dry_run?: boolean
  request_id?: string
}

export type OmniMcpAccessBulk = {
  expected_digest: string
  reason: string
  dry_run?: boolean
  principals?: string[]
} & (
  | { changes: JsonObject[]; template?: never; column?: never }
  | { template: string; changes?: never; column?: never }
  | {
      column: { section: string; access: 'read' | 'write'; on: boolean }
      changes?: never
      template?: never
    }
)

export type Dispatch = {
  people: string[]
  question: string
  idempotency_key: string
  artifact_id?: string
  details?: string
  title?: string
  due?: string
  category?: string
  private?: boolean
}

export type OmniMcpDecision = Dispatch & {
  options: (string | { label: string; detail?: string })[]
  recommended?: number
  multi?: boolean
}

export type OmniMcpSurvey = Dispatch & {
  form: {
    id?: string
    label: string
    type: 'yes_no' | 'one' | 'many' | 'short' | 'long' | 'rating'
    options?: string[]
    required?: boolean
    scale?: number
  }[]
}

export class OmniMcpParityError extends Error {
  constructor(
    readonly code: string,
    readonly result?: JsonObject
  ) {
    super(`OmniSI MCP request failed: ${code}`)
    this.name = 'OmniMcpParityError'
  }
}

export function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

export function requireValue(valid: unknown, code: string): asserts valid {
  if (!valid) {
    throw new OmniMcpParityError(code)
  }
}

export const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const MAX_BYTES = 2 * 1024 * 1024

export async function readRpc(response: Response, id: number): Promise<JsonObject> {
  let value: unknown
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body?.getReader()
    requireValue(reader, 'empty_response')
    const decoder = new TextDecoder()
    let pending = ''
    let bytes = 0
    try {
      while (value === undefined) {
        const chunk = await reader.read()
        requireValue(!chunk.done, 'missing_rpc_response')
        bytes += chunk.value.byteLength
        requireValue(bytes <= MAX_BYTES, 'response_too_large')
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
      reader.releaseLock()
    }
  } else {
    value = await readFetchResponseJsonWithinLimit(response, MAX_BYTES)
  }
  const message = record(value)
  requireValue(message.jsonrpc === '2.0' && message.id === id, 'invalid_rpc_response')
  if (message.error !== undefined) {
    throw new OmniMcpParityError('rpc_error', record(message.error))
  }
  requireValue(
    message.result && typeof message.result === 'object' && !Array.isArray(message.result),
    'invalid_result'
  )
  return record(message.result)
}
