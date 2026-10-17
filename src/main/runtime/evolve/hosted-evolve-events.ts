import {
  parseEvolveHostedEvent,
  type EvolveHostedEvent
} from '../../../shared/evolve-hosted-progress'
import {
  assertValidCloudRunId,
  hostedEvolveAuthRejection,
  hostedEvolveConnection,
  type HostedEvolveClientDeps
} from './hosted-evolve-client'

const CONNECT_TIMEOUT_MS = 20_000
// The service sends a keep-alive comment every 15 s; three missed ones mean the stream is dead.
const IDLE_TIMEOUT_MS = 45_000
const MAX_FRAME_BYTES = 256 * 1024

/** How a stream ended: the server closed it, the token expired, or the viewer fell behind. */
export type HostedEvolveStreamEnd = 'closed' | 'token_expired' | 'resync'

export type HostedEvolveStreamOptions = {
  lastEventId?: string
  signal: AbortSignal
  onOpen?: () => void
  onEvent: (event: EvolveHostedEvent) => void
}

type SseFrame = { id?: string; event?: string; data: string }

/** Splits complete SSE frames off `buffer`; returns the unfinished tail. */
export function takeSseFrames(buffer: string, frames: SseFrame[]): string {
  const normalized = buffer.replace(/\r\n?/g, '\n')
  let start = 0
  for (let end = normalized.indexOf('\n\n'); end !== -1; end = normalized.indexOf('\n\n', start)) {
    const frame: SseFrame = { data: '' }
    const data: string[] = []
    for (const line of normalized.slice(start, end).split('\n')) {
      if (!line || line.startsWith(':')) {
        continue
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'data') {
        data.push(value)
      } else if (field === 'event') {
        frame.event = value
      } else if (field === 'id' && !value.includes('\0')) {
        frame.id = value
      }
    }
    frame.data = data.join('\n')
    if (frame.data || frame.event) {
      frames.push(frame)
    }
    start = end + 2
  }
  return normalized.slice(start)
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/**
 * Reads `GET /api/evolve/runs/:id/events` until the server ends it, the signal aborts or it goes
 * idle. Resumes after `lastEventId`; throws on refusal or a broken stream so callers can poll.
 */
export async function streamHostedEvolveEvents(
  cloudRunId: string,
  options: HostedEvolveStreamOptions,
  deps?: HostedEvolveClientDeps
): Promise<HostedEvolveStreamEnd> {
  const safeId = encodeURIComponent(assertValidCloudRunId(cloudRunId))
  const { url, token, fetchFn } = await hostedEvolveConnection(
    `/api/evolve/runs/${safeId}/events`,
    deps
  )
  const watchdog = new AbortController()
  let idle = setTimeout(() => watchdog.abort(), CONNECT_TIMEOUT_MS)
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => watchdog.abort(), IDLE_TIMEOUT_MS)
  }
  const signal = AbortSignal.any([options.signal, watchdog.signal])
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {})
      },
      redirect: 'error',
      signal
    })
    const rejected = hostedEvolveAuthRejection(response.status)
    if (rejected) {
      throw rejected
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Hosted Evolve event stream refused: HTTP ${response.status}`)
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await response.body.cancel().catch(() => undefined)
      throw new Error('Hosted Evolve event stream answered without text/event-stream.')
    }
    options.onOpen?.()
    touch()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          return 'closed'
        }
        touch()
        buffer += decoder.decode(value, { stream: true })
        const frames: SseFrame[] = []
        buffer = takeSseFrames(buffer, frames)
        if (buffer.length > MAX_FRAME_BYTES) {
          throw new Error('Hosted Evolve event stream sent an oversized frame.')
        }
        for (const frame of frames) {
          if (frame.event === 'token_expired' || frame.event === 'resync') {
            return frame.event
          }
          const event = parseEvolveHostedEvent(parseData(frame.data), {
            id: frame.id,
            type: frame.event
          })
          if (event) {
            options.onEvent(event)
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } finally {
    clearTimeout(idle)
  }
}
