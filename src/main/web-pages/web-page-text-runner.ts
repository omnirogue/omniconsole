import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getAppEnvironment } from '../../shared/app-environment'
import type { WebPageText } from './web-page-text'

export const WEB_PAGE_TEXT_TIMEOUT_MS = 10_000
const WEB_PAGE_TEXT_HEAP_MB = 512

export type WebPageTextRunOptions = {
  /** The run's Stop: terminates the worker and rejects with its reason. */
  signal?: AbortSignal
  /** May shorten the time limit, never extend it. */
  timeoutMs?: number
  /** Tests only: a bundled worker entry. */
  workerPath?: string
}

function webPageTextWorkerPath(): string {
  if (getAppEnvironment().isPackaged()) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'web-page-text-worker.js')
  }
  return join(__dirname, 'web-page-text-worker.js')
}

function isWebPageText(value: unknown): value is WebPageText {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.text === 'string' &&
    typeof record.title === 'string' &&
    typeof record.removedLines === 'number' &&
    typeof record.truncated === 'boolean'
  )
}

/**
 * Runs the HTML-to-text step on a worker thread with a time and heap limit. The parser and
 * toText are superlinear on hostile markup, so a page must never get that work on the main thread.
 * Resolves null when the worker fails or runs out of time: the page then has no readable text.
 */
export function webPageTextOffThread(
  body: Uint8Array,
  type: string,
  charset: string | null,
  options: WebPageTextRunOptions = {}
): Promise<WebPageText | null> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason)
  }
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(options.workerPath ?? webPageTextWorkerPath(), {
        workerData: { body, type, charset },
        resourceLimits: { maxOldGenerationSizeMb: WEB_PAGE_TEXT_HEAP_MB }
      })
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const timeoutMs = Math.max(
      0,
      Math.min(WEB_PAGE_TEXT_TIMEOUT_MS, options.timeoutMs ?? WEB_PAGE_TEXT_TIMEOUT_MS)
    )
    const finish = (outcome: () => void) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', stop)
      worker.removeAllListeners()
      // A late error from a worker being torn down must not become an uncaught event.
      worker.on('error', () => {})
      void worker.terminate()
      outcome()
    }
    const stop = () => finish(() => reject(options.signal?.reason))
    const timeout = setTimeout(() => finish(() => resolve(null)), timeoutMs)
    timeout.unref?.()
    options.signal?.addEventListener('abort', stop, { once: true })
    worker.once('message', (message: unknown) =>
      finish(() => resolve(isWebPageText(message) ? message : null))
    )
    worker.once('error', () => finish(() => resolve(null)))
    worker.once('exit', () => finish(() => resolve(null)))
  })
}
