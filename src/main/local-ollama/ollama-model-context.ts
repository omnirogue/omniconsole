import { isOllamaModelTag, sameOllamaTag } from '../../shared/local-ollama-launch'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { resolveOllamaBaseUrl } from './ollama-inventory'

const CONTEXT_PROBE_TIMEOUT_MS = 4_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** One metadata reply as a record; its body is always read or cancelled. */
export async function readOllamaMetadata(
  url: string,
  init?: RequestInit
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(CONTEXT_PROBE_TIMEOUT_MS)
    })
    try {
      return response.ok ? record(await response.json()) : undefined
    } finally {
      await cancelUnreadResponseBody(response)
    }
  } catch {
    return undefined
  }
}

/** Native capacity is a ceiling, not evidence of the runner's configured context. */
export function nativeContext(info: Record<string, unknown> | undefined): number | undefined {
  if (!info) {
    return undefined
  }
  const architecture = info['general.architecture']
  if (typeof architecture === 'string') {
    return positiveInteger(info[`${architecture}.context_length`])
  }
  const lengths = Object.entries(info)
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => positiveInteger(value))
    .filter((value): value is number => value !== undefined)
  return lengths.length ? Math.min(...lengths) : undefined
}

/** Reads only metadata; an unloaded model is never loaded just to discover its context. */
export async function readOllamaModelContext(
  model: string,
  baseUrl?: string
): Promise<number | undefined> {
  if (!isOllamaModelTag(model)) {
    return undefined
  }
  const base = resolveOllamaBaseUrl(baseUrl)
  const [running, details] = await Promise.all([
    readOllamaMetadata(`${base}/api/ps`),
    readOllamaMetadata(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    })
  ])
  const native = nativeContext(record(details?.model_info))
  const contexts = (Array.isArray(running?.models) ? running.models : [])
    .map(record)
    .filter((entry) =>
      [entry?.name, entry?.model].some(
        (tag) => typeof tag === 'string' && sameOllamaTag(model, tag)
      )
    )
    .map((entry) => positiveInteger(entry?.context_length))
    .filter((value): value is number => value !== undefined)
  const explicit =
    typeof details?.parameters === 'string'
      ? positiveInteger(Number(/^num_ctx\s+(\d+)\s*$/m.exec(details.parameters)?.[1]))
      : undefined
  const context = contexts.length ? Math.min(...contexts) : explicit
  return context !== undefined && native !== undefined ? Math.min(context, native) : context
}
