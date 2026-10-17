import {
  OLLAMA_DEFAULT_BASE_URL,
  isOllamaModelTag,
  type OllamaInstalledModel,
  type OllamaInventory
} from '../../shared/local-ollama-launch'

/**
 * Talks to a local Ollama server over its REST API (docs.ollama.com/api): `/api/tags` for
 * what is installed, `/api/pull` (NDJSON stream) to install by tag. Loss of contact is
 * reported as `disconnected`, never as "no models".
 */

const TAGS_TIMEOUT_MS = 4_000
/** Idle limit between chunks; a slow but moving download is never cut off. */
const PULL_IDLE_TIMEOUT_MS = 10 * 60 * 1000

type TagsResponse = {
  models?: {
    name?: unknown
    size?: unknown
    modified_at?: unknown
    details?: { family?: unknown; parameter_size?: unknown; quantization_level?: unknown }
  }[]
}

/** Explicit argument, then the same `OLLAMA_HOST` the ollama CLI honours, then the default. */
export function resolveOllamaBaseUrl(baseUrl?: string): string {
  let configured = baseUrl?.trim() || process.env.OLLAMA_HOST?.trim() || OLLAMA_DEFAULT_BASE_URL
  // Why: the ollama CLI accepts `:11434` and means 127.0.0.1.
  if (/^:\d+$/.test(configured)) {
    configured = `127.0.0.1${configured}`
  }
  const hadScheme = /^https?:\/\//i.test(configured)
  // Why: a bare IPv6 literal such as `::1` needs brackets before it can carry a port.
  if (!hadScheme && /^[0-9a-f:]+$/i.test(configured) && configured.split(':').length > 2) {
    configured = `[${configured}]`
  }
  const hadPort = configured.includes('[')
    ? /\]:\d+(\/|$)/.test(configured)
    : /:\d+(\/|$)/.test(configured)
  const withScheme = hadScheme ? configured : `http://${configured}`
  try {
    const url = new URL(withScheme)
    // Why: like the ollama CLI, a bare host means port 11434; an explicit scheme or port is kept
    // (URL reports an explicit :80/:443 as empty, so the raw string decides).
    if (!url.port && !hadScheme && !hadPort) {
      url.port = '11434'
    }
    // Why: some users paste the OpenAI-compatible URL; the REST API lives at the root.
    return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '')
  } catch {
    return withScheme.replace(/\/+$/, '').replace(/\/v1$/, '')
  }
}

const baseOf = resolveOllamaBaseUrl

/** `HTTP 404` plus Ollama's own `{error}` text when the body carries one. */
async function httpFailure(response: Response): Promise<string> {
  const status = `HTTP ${response.status}`
  try {
    const text = (await response.text()).slice(0, 2000)
    const body = JSON.parse(text) as { error?: unknown }
    return typeof body.error === 'string' ? `${status}: ${body.error}` : status
  } catch {
    return status
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : error.message
  }
  return String(error)
}

export async function listOllamaModels(baseUrl?: string): Promise<OllamaInventory> {
  const base = baseOf(baseUrl)
  let response: Response
  try {
    response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) })
  } catch (error) {
    return { status: 'disconnected', baseUrl: base, message: describeFailure(error) }
  }
  if (!response.ok) {
    return { status: 'disconnected', baseUrl: base, message: await httpFailure(response) }
  }
  let parsed: TagsResponse
  try {
    parsed = (await response.json()) as TagsResponse
  } catch (error) {
    return { status: 'disconnected', baseUrl: base, message: describeFailure(error) }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'disconnected', baseUrl: base, message: 'Unexpected /api/tags response.' }
  }
  if (typeof (parsed as { error?: unknown }).error === 'string') {
    return { status: 'disconnected', baseUrl: base, message: (parsed as { error: string }).error }
  }
  if (!Array.isArray(parsed.models)) {
    return { status: 'disconnected', baseUrl: base, message: 'Unexpected /api/tags response.' }
  }
  const models: OllamaInstalledModel[] = []
  for (const entry of parsed.models) {
    if (!entry || typeof entry !== 'object' || !isOllamaModelTag(entry.name)) {
      continue
    }
    models.push({
      name: entry.name,
      sizeBytes: typeof entry.size === 'number' ? entry.size : 0,
      ...(typeof entry.details?.family === 'string' ? { family: entry.details.family } : {}),
      ...(typeof entry.details?.parameter_size === 'string'
        ? { parameterSize: entry.details.parameter_size }
        : {}),
      ...(typeof entry.details?.quantization_level === 'string'
        ? { quantization: entry.details.quantization_level }
        : {}),
      ...(typeof entry.modified_at === 'string' ? { modifiedAt: entry.modified_at } : {})
    })
  }
  models.sort((a, b) => a.name.localeCompare(b.name))
  return { status: 'connected', baseUrl: base, models }
}

export type OllamaPullProgress = {
  model: string
  status: string
  completedBytes?: number
  totalBytes?: number
}

export type OllamaPullResult = { ok: true } | { ok: false; message: string }

/** Streams `/api/pull`; resolves once Ollama reports `success` or the stream ends. */
export async function pullOllamaModel(args: {
  model: string
  baseUrl?: string
  onProgress?: (progress: OllamaPullProgress) => void
}): Promise<OllamaPullResult> {
  if (!isOllamaModelTag(args.model)) {
    return { ok: false, message: 'Not a valid model tag.' }
  }
  const base = baseOf(args.baseUrl)
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error('timed out')), PULL_IDLE_TIMEOUT_MS)
  }
  armIdle()
  let response: Response
  try {
    response = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: args.model, stream: true }),
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(idleTimer)
    return { ok: false, message: describeFailure(error) }
  }
  if (!response.ok || !response.body) {
    // Why: the deadline stays armed while the error body is read; a stalled body still settles.
    try {
      return { ok: false, message: await httpFailure(response) }
    } finally {
      clearTimeout(idleTimer)
    }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let sawSuccess = false
  let lastError: string | null = null
  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim()
    if (!line || lastError) {
      return
    }
    let event: { status?: unknown; error?: unknown; completed?: unknown; total?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (typeof event.error === 'string') {
      // Why: Ollama reports a failed pull once; nothing useful follows it.
      lastError = event.error
      return
    }
    const status = typeof event.status === 'string' ? event.status : ''
    if (status === 'success') {
      sawSuccess = true
    }
    args.onProgress?.({
      model: args.model,
      status,
      ...(typeof event.completed === 'number' ? { completedBytes: event.completed } : {}),
      ...(typeof event.total === 'number' ? { totalBytes: event.total } : {})
    })
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done || lastError || sawSuccess) {
        break
      }
      armIdle()
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      lines.forEach(handleLine)
      // Why: Ollama's `success` is final; a later socket error or stall must not undo it.
      if (lastError || sawSuccess) {
        break
      }
    }
    buffered += decoder.decode()
    handleLine(buffered)
  } catch (error) {
    return { ok: false, message: describeFailure(error) }
  } finally {
    clearTimeout(idleTimer)
    await reader.cancel().catch(() => undefined)
  }
  if (lastError) {
    return { ok: false, message: lastError }
  }
  return sawSuccess ? { ok: true } : { ok: false, message: 'Pull ended without success.' }
}
