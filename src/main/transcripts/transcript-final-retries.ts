import type { AppHealthReportInput } from '../../shared/app-health-contract'

/** A final that did not deliver is retried this often, for this long, then reported. */
export const TRANSCRIPT_FINAL_RETRY_INTERVAL_MS = 10 * 60 * 1000
export const TRANSCRIPT_FINAL_RETRY_WINDOW_MS = 60 * 60 * 1000

type EndedSession = {
  identity: { sessionKey: string; sessionId: string; agent: string }
  timer: NodeJS.Timeout | null
  finalPending?: { firstFailureAt: number }
}

/**
 * Ended sessions whose real final has not reached the server: a 5xx, a read
 * that came back empty because the agent had not flushed its file yet, a quit
 * that aborted the read. Routing SessionEnd to `final` removed the ten-minute
 * checkpoint safety net, so this is that net for finals — every ten minutes for
 * an hour, and once more at quit; after that one `final_failed` health row.
 */
export class TranscriptFinalRetries<S extends EndedSession> {
  private readonly ended = new Map<string, S>()

  constructor(
    private readonly deps: {
      now: () => number
      /** True when the real final was delivered. */
      retry: (session: S, quitting: boolean) => Promise<boolean>
      reportHealth: (input: AppHealthReportInput) => void
    }
  ) {}

  get size(): number {
    return this.ended.size
  }

  private key(session: S): string {
    return `${session.identity.sessionKey}|${session.identity.sessionId}`
  }

  forget(session: S): void {
    this.ended.delete(this.key(session))
  }

  keep(session: S): void {
    const now = this.deps.now()
    session.finalPending ??= { firstFailureAt: now }
    const key = this.key(session)
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (now - session.finalPending.firstFailureAt >= TRANSCRIPT_FINAL_RETRY_WINDOW_MS) {
      this.ended.delete(key)
      this.deps.reportHealth({
        feature: 'transcript_upload',
        status: 'error',
        code: 'final_failed',
        message: `${session.identity.agent} session ${session.identity.sessionId}`
      })
      return
    }
    this.ended.set(key, session)
    session.timer = setTimeout(() => {
      session.timer = null
      void this.retryOne(key, false)
    }, TRANSCRIPT_FINAL_RETRY_INTERVAL_MS)
    session.timer.unref?.()
  }

  private async retryOne(key: string, quitting: boolean): Promise<void> {
    const session = this.ended.get(key)
    if (!session) {
      return
    }
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    const delivered = await this.deps.retry(session, quitting).catch(() => false)
    if (delivered) {
      this.ended.delete(key)
    } else {
      this.keep(session)
    }
  }

  /** Quit: every ended session gets one more short attempt. */
  retryAll(quitting: boolean): Promise<void> {
    return Promise.allSettled(
      [...this.ended.keys()].map((key) => this.retryOne(key, quitting))
    ).then(() => undefined)
  }
}
