import type { WebPageReading } from '../../../web-pages/web-page-reader'

/** One web call's whole limit: a page still unread then is unread for good. */
export const GRAPH_WEB_CALL_TIMEOUT_MS = 90_000
export const GRAPH_WEB_CONCURRENCY = 4
export const GRAPH_WEB_PER_SITE = 2

/** Reads one page; rejects only when its signal aborts. */
export type GraphWebReader = (
  url: string,
  options: { signal: AbortSignal }
) => Promise<WebPageReading>

const timedOut = (): WebPageReading => ({
  state: 'unreadable',
  reason: { code: 'timeout', limit: 'call' },
  redirects: []
})

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Every page in order, at most 4 at once and 2 per site. The call's limit ends it at once, with
 * every unfinished page a timeout; Stop rejects at once, so a stopped call keeps nothing.
 */
export function readGraphWebPages(
  urls: readonly string[],
  read: GraphWebReader,
  stop?: AbortSignal
): Promise<WebPageReading[]> {
  stop?.throwIfAborted()
  const limit = new AbortController()
  const signal = stop ? AbortSignal.any([stop, limit.signal]) : limit.signal
  const readings: (WebPageReading | undefined)[] = urls.map(() => undefined)
  const waiting = urls.map((url, index) => ({ url, index, site: siteOf(url) }))
  const open = new Map<string, number>()
  let running = 0
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<WebPageReading[]>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        stop?.removeEventListener('abort', stopped)
        settle()
      }
    }
    const stopped = () => finish(() => reject(stop!.reason))
    const pump = () => {
      for (let at = 0; !done && at < waiting.length && running < GRAPH_WEB_CONCURRENCY;) {
        const page = waiting[at]!
        const busy = open.get(page.site) ?? 0
        if (busy >= GRAPH_WEB_PER_SITE) {
          at += 1
          continue
        }
        waiting.splice(at, 1)
        running += 1
        open.set(page.site, busy + 1)
        read(page.url, { signal }).then(
          (reading) => {
            readings[page.index] = reading
            running -= 1
            open.set(page.site, (open.get(page.site) ?? 1) - 1)
            pump()
          },
          // Stop and the limit settle first, so a rejection still open here is a defect: loud.
          (error: unknown) => finish(() => reject(error))
        )
      }
      if (!running && !waiting.length) {
        finish(() => resolve(readings as WebPageReading[]))
      }
    }
    timer = setTimeout(() => {
      finish(() => resolve(readings.map((reading) => reading ?? timedOut())))
      limit.abort()
    }, GRAPH_WEB_CALL_TIMEOUT_MS)
    stop?.addEventListener('abort', stopped, { once: true })
    pump()
  })
}
