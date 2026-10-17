import {
  APP_HEALTH_APP,
  clipAppHealthMessage,
  type AppHealthReportBody,
  type AppHealthReportInput
} from '../../shared/app-health-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'

export const APP_HEALTH_DEDUPE_WINDOW_MS = 5 * 60 * 1000
export const APP_HEALTH_QUEUE_LIMIT = 50

export type AppHealthSendResult = { ok: true } | { ok: false; status: number | null; error: string }

export type AppHealthReporterDeps = {
  send: (body: AppHealthReportBody) => Promise<ConsoleWorkflowResult<unknown>>
  isSignedIn: () => boolean
  appVersion: () => string
  platform: () => string
  now?: () => number
}

/**
 * Fire-and-forget health reports to the console. Why a queue and not a direct
 * send: reports arrive in bursts (startup, several sessions ending at quit) and
 * the transport captures the signed person per request, so they are sent one at
 * a time, in order, and a burst beyond the queue limit drops the oldest — health
 * is a signal, never something worth holding the app for.
 *
 * Dedupe is per (feature, code): the same failure repeating inside five minutes
 * is one row, not fifty. `crash` is exempt, because each report id is its own event.
 */
export class AppHealthReporter {
  private readonly queue: AppHealthReportBody[] = []
  private readonly lastSentAt = new Map<string, number>()
  private draining: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly deps: AppHealthReporterDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Enqueue and return; the send happens in the background. */
  report(input: AppHealthReportInput): void {
    // Signed out first: nothing is stamped or queued, and no Electron API is touched.
    if (!this.deps.isSignedIn()) {
      return
    }
    const body = this.buildBody(input)
    if (!body) {
      return
    }
    if (this.isDuplicate(body)) {
      return
    }
    this.queue.push(body)
    while (this.queue.length > APP_HEALTH_QUEUE_LIMIT) {
      this.queue.shift()
    }
    this.drain()
  }

  /** Awaited variant for callers that show the outcome (the crash dialog). Not deduped. */
  async reportAndWait(input: AppHealthReportInput): Promise<AppHealthSendResult> {
    const body = this.buildBody(input)
    if (!body) {
      return { ok: false, status: null, error: 'The health report is malformed.' }
    }
    if (!this.deps.isSignedIn()) {
      return { ok: false, status: null, error: 'Sign in to OmniConsole to send a report.' }
    }
    const result = await this.deps.send(body)
    return result.ok
      ? { ok: true }
      : { ok: false, status: result.error.status ?? null, error: result.error.message }
  }

  /** Settles when everything queued so far has been attempted (bounded by the transport). */
  flush(): Promise<void> {
    return this.draining ?? Promise.resolve()
  }

  pendingCount(): number {
    return this.queue.length
  }

  private buildBody(input: AppHealthReportInput): AppHealthReportBody | null {
    if (!input.feature || !input.status) {
      return null
    }
    return {
      app: APP_HEALTH_APP,
      version: this.deps.appVersion(),
      platform: this.deps.platform(),
      feature: input.feature,
      status: input.status,
      ...(input.code ? { code: input.code } : {}),
      ...(input.message ? { message: clipAppHealthMessage(input.message) } : {}),
      at: input.at ?? new Date(this.now()).toISOString()
    }
  }

  private isDuplicate(body: AppHealthReportBody): boolean {
    if (body.feature === 'crash') {
      return false
    }
    const key = `${body.feature}\0${body.status}\0${body.code ?? ''}`
    const previous = this.lastSentAt.get(key)
    const now = this.now()
    if (previous !== undefined && now - previous < APP_HEALTH_DEDUPE_WINDOW_MS) {
      return true
    }
    this.lastSentAt.set(key, now)
    return false
  }

  private drain(): void {
    if (this.draining) {
      return
    }
    this.draining = (async () => {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!
        try {
          await this.deps.send(next)
        } catch {
          // Why: health must never surface as an error of its own; the transport
          // already contains URLs and credentials, and a failure here is just lost signal.
        }
      }
    })().finally(() => {
      this.draining = null
    })
  }
}
