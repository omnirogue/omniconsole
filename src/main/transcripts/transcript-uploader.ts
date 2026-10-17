// ─── Employee transcript uploader ───────────────────────────────────────────
// Every IDE agent session's transcript goes to the console on the signed-in
// employee's behalf (Sal, 2026-09-13): a checkpoint at most once per ten
// minutes while the session runs, and a final snapshot when it ends. The
// server keeps the latest snapshot per session, so each upload is the whole
// session from its first message; a read that came back partial is withheld
// (a stub says so), never posted as if it were the record.

import type { AppHealthReportInput } from '../../shared/app-health-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { EmployeeTranscriptUploadBody } from '../../shared/employee-transcript-contract'
import type {
  SessionTranscriptBuild,
  SessionTranscriptSource
} from './session-transcript-deliverable'
import { transcriptSessionScope, type TranscriptSessionScope } from './transcript-session-scope'
import { TranscriptFinalRetries } from './transcript-final-retries'
import { TranscriptSequenceStore } from './transcript-sequence-store'
import { captureAndDecide } from './transcript-upload-decision'
import {
  abortableSleep,
  linkedAbortController,
  sendTranscriptUpload,
  bindSessionPrincipal,
  sendTranscriptWithFallbacks,
  type TranscriptPrincipal,
  type TranscriptUploadOptions
} from './transcript-upload-send'

export const TRANSCRIPT_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000
/** Coalesces a burst of Stop/SubagentStop events into one read. */
export const TRANSCRIPT_CHECKPOINT_SETTLE_MS = 3_000
export const TRANSCRIPT_UPLOAD_TIMEOUT_MS = 60_000
/** At quit: one attempt, aborted well inside the will-quit deadline. */
export const TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS = 3_000

export type TranscriptSessionIdentity = {
  sessionKey: string
  agent: string
  sessionId: string
  transcriptPath?: string
  model?: string | null
  cwd?: string | null
}

type LiveSession = {
  identity: TranscriptSessionIdentity
  startedAt: string
  scope: TranscriptSessionScope
  /** Last attempt, sent or not; the interval is between reads, so an unchanged
   *  session is not re-read on every Stop. */
  lastAttemptAt: number | null
  lastUploadAt: number | null
  lastSha256: string | null
  timer: NodeJS.Timeout | null
  inFlight: Promise<void> | null
  /** Aborts the run in flight: a final supersedes a checkpoint, quit bounds a final. */
  abort: AbortController | null
  /** Set once the session ended and its final has not delivered the real record yet. */
  finalPending?: { firstFailureAt: number }
  /** A final has started: no checkpoint may run after it. */
  finalized?: boolean
  /** The owner, read synchronously at observation (no bearer involved); null =
   *  nobody was signed in, and the session is never claimed by anyone later. */
  owner: string | null
  /** The credentialed capture for the owner, serialized: one in flight per session. */
  principalCapture: Promise<TranscriptPrincipal | null> | null
}

/** What one run achieved. A stub for a failed read records the session but is not the record. */
type RunOutcome = 'delivered' | 'stub' | 'failed' | 'skipped'

export type { TranscriptPrincipal, TranscriptUploadOptions }

export type TranscriptUploaderDeps = {
  isSignedIn: () => boolean
  build: (source: SessionTranscriptSource, signal?: AbortSignal) => Promise<SessionTranscriptBuild>
  upload: (
    body: EmployeeTranscriptUploadBody,
    options: TranscriptUploadOptions
  ) => Promise<ConsoleWorkflowResult<unknown>>
  reportHealth: (input: AppHealthReportInput) => void
  /** The signed-in person's principal, synchronously and without a bearer, or null. */
  currentOwner: () => string | null
  /** The signed-in person with a live credential, or null; must match the owner. */
  capturePrincipal: () => Promise<TranscriptPrincipal | null>
  appVersion: () => string
  host: () => string
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  scope?: (cwd: string | null) => TranscriptSessionScope
  /** Sequence numbers survive pane lifetimes and restarts; null directory = memory only. */
  sequences?: TranscriptSequenceStore
}

export class TranscriptUploader {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Every run in flight, by what it is; quit aborts checkpoints now and finals at its deadline. */
  private readonly activeRuns = new Map<AbortController, 'checkpoint' | 'final'>()
  /** Set for the duration of quit; every run started after it is bound to it. */
  private quitSignal: AbortSignal | null = null
  private readonly scopeOf: (cwd: string | null) => TranscriptSessionScope
  private readonly sequences: TranscriptSequenceStore
  /** Finals whose session is already forgotten but whose upload is still in flight. */
  private readonly pendingFinals = new Set<Promise<void>>()
  /** Ended sessions whose real final has not been delivered yet. */
  private readonly finalRetries: TranscriptFinalRetries<LiveSession>

  constructor(private readonly deps: TranscriptUploaderDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? abortableSleep
    this.scopeOf = deps.scope ?? ((cwd) => transcriptSessionScope(cwd))
    this.sequences = deps.sequences ?? new TranscriptSequenceStore(null)
    this.finalRetries = new TranscriptFinalRetries({
      now: this.now,
      retry: async (session, quitting) => {
        const outcome = await this.run(session, 'final', quitting).catch((): RunOutcome => 'failed')
        await this.sequences.flush().catch(() => undefined)
        return outcome === 'delivered'
      },
      reportHealth: deps.reportHealth
    })
  }

  /** A session was seen (or its identity refreshed). A new session id in the same
   *  pane finalizes the one before it: `/clear` and resume both change the id. */
  observe(identity: TranscriptSessionIdentity): void {
    const existing = this.sessions.get(identity.sessionKey)
    if (existing && existing.identity.sessionId !== identity.sessionId) {
      void this.final(identity.sessionKey)
    } else if (existing) {
      existing.identity = {
        ...existing.identity,
        ...identity,
        model: identity.model ?? existing.identity.model ?? null,
        cwd: identity.cwd ?? existing.identity.cwd ?? null
      }
      // Why: the worktree path often arrives on a later hook event than the first.
      existing.scope = this.scopeOf(existing.identity.cwd ?? null)
      return
    }
    const session: LiveSession = {
      // Why synchronous: the owner is whoever is signed in at this instant; a bearer
      // refresh that fails or an account switch before it resolves must not re-attribute.
      owner: this.deps.currentOwner(),
      principalCapture: null,
      identity: { ...identity, model: identity.model ?? null, cwd: identity.cwd ?? null },
      startedAt: new Date(this.now()).toISOString(),
      scope: this.scopeOf(identity.cwd ?? null),
      lastAttemptAt: null,
      lastUploadAt: null,
      lastSha256: null,
      timer: null,
      inFlight: null,
      abort: null
    }
    this.sessions.set(identity.sessionKey, session)
  }

  has = (sessionKey: string): boolean => this.sessions.has(sessionKey)

  liveSessionKeys = (): string[] => [...this.sessions.keys()]

  /** Debounced: at most one checkpoint per session per interval, never during another upload. */
  scheduleCheckpoint(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.timer) {
      return
    }
    const since = session.lastAttemptAt === null ? Infinity : this.now() - session.lastAttemptAt
    const wait = Math.max(
      TRANSCRIPT_CHECKPOINT_SETTLE_MS,
      TRANSCRIPT_CHECKPOINT_INTERVAL_MS - since
    )
    session.timer = setTimeout(() => {
      session.timer = null
      void this.run(session, 'checkpoint', false).catch(() => undefined)
    }, wait)
    session.timer.unref?.()
  }

  /** The session ended: one last, complete upload, then forget it. A final that
   *  did not deliver the record keeps the session as an ended entry, retried every
   *  ten minutes for an hour (and at quit), then reported as `final_failed`. */
  async final(sessionKey: string, quitting = false): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) {
      return
    }
    this.sessions.delete(sessionKey)
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    // Why tracked: a tab closed just before quit must still reach finalizeAll.
    const pending = this.completeFinal(session, quitting)
      .catch(() => undefined)
      .finally(() => {
        this.pendingFinals.delete(pending)
      })
    this.pendingFinals.add(pending)
    await pending
  }

  private async completeFinal(session: LiveSession, quitting: boolean): Promise<void> {
    const outcome = await this.run(session, 'final', quitting)
    await this.sequences.flush().catch(() => undefined)
    if (outcome === 'delivered') {
      this.finalRetries.forget(session)
      return
    }
    this.finalRetries.keep(session)
  }

  /** Quit: one shared deadline. Checkpoints in flight are aborted (their final
   *  supersedes them), every final starts now with one short attempt, and finals
   *  already in flight are bound to the same signal. */
  async finalizeAll(): Promise<void> {
    const quit = AbortSignal.timeout(TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS)
    this.quitSignal = quit
    for (const [controller, kind] of this.activeRuns) {
      if (kind === 'checkpoint') {
        controller.abort()
      } else {
        quit.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }
    await Promise.allSettled([
      ...this.liveSessionKeys().map((key) => this.final(key, true)),
      this.finalRetries.retryAll(true),
      ...this.pendingFinals
    ])
    await this.sequences.flush().catch(() => undefined)
  }

  /** Ended sessions still waiting on their real final (test seam). */
  pendingFinalCount = (): number => this.finalRetries.size

  /** One run at a time per session, chained synchronously: the slot is taken
   *  before anything is awaited, a final aborts the checkpoint ahead of it, and
   *  a checkpoint queued behind a final never runs. */
  private run(
    session: LiveSession,
    snapshot: 'checkpoint' | 'final',
    quitting: boolean
  ): Promise<RunOutcome> {
    const previous = session.inFlight
    if (snapshot === 'final') {
      session.finalized = true
      // The final carries everything the checkpoint would have; do not wait behind it.
      session.abort?.abort()
    }
    const attempt = (async (): Promise<RunOutcome> => {
      if (previous) {
        await previous.catch(() => undefined)
      }
      if (snapshot === 'checkpoint' && session.finalized) {
        return 'skipped'
      }
      if (!this.deps.isSignedIn()) {
        return 'skipped'
      }
      // Why linked: a run started after quit began is bound by the quit deadline too.
      const controller = linkedAbortController(this.quitSignal)
      session.abort = controller
      this.activeRuns.set(controller, snapshot)
      try {
        return await this.uploadSnapshot(session, snapshot, quitting, controller.signal)
      } finally {
        if (session.abort === controller) {
          session.abort = null
        }
        this.activeRuns.delete(controller)
      }
    })()
    const slot = attempt
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (session.inFlight === slot) {
          session.inFlight = null
        }
      })
    session.inFlight = slot
    return attempt
  }

  private async uploadSnapshot(
    session: LiveSession,
    snapshot: 'checkpoint' | 'final',
    quitting: boolean,
    signal: AbortSignal
  ): Promise<RunOutcome> {
    const { identity } = session
    const principal = await bindSessionPrincipal(session, this.deps.capturePrincipal)
    if (!principal || !principal.isCurrent() || this.deps.currentOwner() !== session.owner) {
      // Held, not sent: the session belongs to someone who is no longer signed in.
      this.deps.reportHealth({
        feature: 'transcript_upload',
        status: 'error',
        code: 'principal_changed'
      })
      return 'failed'
    }
    await this.sequences.load()
    session.lastAttemptAt = this.now()
    const { agent, sessionId } = identity
    const { built, facts, stamp, decision } = await captureAndDecide({
      identity,
      startedAt: session.startedAt,
      scope: session.scope,
      snapshot,
      capturedAt: new Date(session.lastAttemptAt).toISOString(),
      seq: this.sequences.peek(agent, sessionId),
      appVersion: this.deps.appVersion(),
      host: this.deps.host(),
      lastSha256: session.lastSha256,
      build: (source) => this.deps.build(source, signal),
      reportHealth: this.deps.reportHealth
    })
    if (signal.aborted && snapshot === 'checkpoint') {
      // Superseded by a final (or quit); the final records the session.
      return 'skipped'
    }
    if (decision.kind === 'skip') {
      return 'skipped'
    }
    const timeoutMs = quitting ? TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS : TRANSCRIPT_UPLOAD_TIMEOUT_MS
    const options = {
      timeoutMs,
      signal,
      expectedPrincipal: principal.principal,
      expectedPersonIsCurrent: principal.isCurrent
    }
    const { sent, sha256 } = await sendTranscriptWithFallbacks({
      body: decision.body,
      sha256: decision.sha256,
      facts,
      stamp,
      quitting,
      options,
      commitSeq: (seq) => this.sequences.commit(agent, sessionId, seq),
      send: (body) => sendTranscriptUpload(this.deps.upload, this.sleep, body, quitting, options),
      reportHealth: this.deps.reportHealth
    })
    if (sent.ok) {
      session.lastUploadAt = this.now()
      session.lastSha256 = sha256
      this.deps.reportHealth({ feature: 'transcript_upload', status: 'ok', code: snapshot })
      return built.kind === 'error' ? 'stub' : 'delivered'
    }
    // A stale answer is not a delivery: the digest stays unset and the next run re-sends.
    const failure = sent.stale
      ? { code: 'stale_snapshot' }
      : sent.code === 'principal_mismatch'
        ? { code: 'principal_changed' }
        : { code: sent.status ? `http_${sent.status}` : sent.code, message: sent.message }
    this.deps.reportHealth({ feature: 'transcript_upload', status: 'error', ...failure })
    return 'failed'
  }
}
