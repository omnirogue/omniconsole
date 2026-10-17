import type { AppHealthReportInput } from '../../shared/app-health-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { EmployeeTranscriptUploadBody } from '../../shared/employee-transcript-contract'
import { EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES } from '../backoffice/console-workflow-request-budget'
import type { TranscriptUploadSessionFacts, TranscriptUploadStamp } from './transcript-upload-body'
import { withheldAfterTransportRefusal } from './transcript-upload-decision'

export const TRANSCRIPT_UPLOAD_ATTEMPTS = 3
const RETRY_BACKOFF_MS = [1_000, 4_000]

/** Who the session was observed under; every send and retry is fenced to them. */
export type TranscriptPrincipal = { principal: string; isCurrent: () => boolean }

export type TranscriptUploadOptions = {
  timeoutMs: number
  signal?: AbortSignal
  expectedPrincipal?: string
  expectedPersonIsCurrent?: () => boolean
}

export type TranscriptSendOutcome =
  | { ok: true }
  | { ok: false; stale: true; storedSeq: number | null }
  | { ok: false; stale?: false; status?: number; code: string; message: string }

/** The stored seq the hub names on a 409. It lives only in the message —
 *  "snapshot seq {submitted} is older than the stored seq {stored}" — while
 *  `details.seq` is the SUBMITTED seq and must never be read as the stored one. */
const STORED_SEQ_IN_MESSAGE = /older than the stored seq (\d{1,15})\b/
function storedSeqFrom(message: string): number | null {
  const found = STORED_SEQ_IN_MESSAGE.exec(message)
  const seq = found ? Number(found[1]) : Number.NaN
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null
}

/** Three tries on transport/5xx failures, then give up until the next checkpoint.
 *  At quit: one try. A 409 `stale_snapshot` is answered to the caller, never retried here. */
export async function sendTranscriptUpload(
  upload: (
    body: EmployeeTranscriptUploadBody,
    options: TranscriptUploadOptions
  ) => Promise<ConsoleWorkflowResult<unknown>>,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  body: EmployeeTranscriptUploadBody,
  quitting: boolean,
  options: TranscriptUploadOptions
): Promise<TranscriptSendOutcome> {
  const attempts = quitting ? 1 : TRANSCRIPT_UPLOAD_ATTEMPTS
  let last: TranscriptSendOutcome = { ok: false, code: 'backoffice_unavailable', message: '' }
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, code: 'aborted', message: 'The upload was abandoned.' }
    }
    // Why before every attempt: an account switch between retries must hold the
    // snapshot, never send person A's session as person B.
    if (options.expectedPersonIsCurrent && !options.expectedPersonIsCurrent()) {
      return { ok: false, code: 'principal_mismatch', message: 'The signed-in person changed.' }
    }
    const result = await upload(body, options)
    if (result.ok) {
      return { ok: true }
    }
    const { code, message, status } = result.error
    if (code === 'principal_mismatch' || code === 'connection_changed') {
      return { ok: false, code: 'principal_mismatch', message }
    }
    if (status === 409 && code === 'stale_snapshot') {
      return { ok: false, stale: true, storedSeq: storedSeqFrom(message) }
    }
    last = { ok: false, code, message, ...(status === undefined ? {} : { status }) }
    const retryable = code === 'backoffice_unavailable' || (status !== undefined && status >= 500)
    if (!retryable) {
      break
    }
    const backoff = RETRY_BACKOFF_MS[attempt]
    if (backoff !== undefined && attempt < attempts - 1) {
      await sleep(backoff, options.signal)
    }
  }
  return last
}

/**
 * One document's delivery with its two fallbacks: a 409 stale_snapshot continues
 * past the seq the hub holds (or +1 when it did not say), once; a transport-gate refusal (its redaction pass or
 * size budget) sends the withheld stub instead, so the session still gets its row.
 * Every sequence number handed out is committed before it is sent, success or not.
 */
export async function sendTranscriptWithFallbacks(args: {
  body: EmployeeTranscriptUploadBody
  sha256: string | null
  facts: TranscriptUploadSessionFacts
  stamp: TranscriptUploadStamp
  quitting: boolean
  options: TranscriptUploadOptions
  commitSeq: (seq: number) => void
  send: (body: EmployeeTranscriptUploadBody) => Promise<TranscriptSendOutcome>
  reportHealth: (input: AppHealthReportInput) => void
}): Promise<{ sent: TranscriptSendOutcome; sha256: string | null }> {
  let { body, sha256 } = args
  args.commitSeq(body.seq)
  let sent = await args.send(body)
  if (!sent.ok && sent.stale) {
    // One bounded recovery: the hub names the seq it holds; continue past it. Without
    // it, +1 once and say so — never a loop, never an arbitrary jump.
    if (sent.storedSeq === null) {
      args.reportHealth({
        feature: 'transcript_upload',
        status: 'error',
        code: 'stale_seq_unrecoverable'
      })
    }
    body = { ...body, seq: Math.max(body.seq, sent.storedSeq ?? body.seq) + 1 }
    args.commitSeq(body.seq)
    sent = await args.send(body)
  }
  const gateRefused =
    !sent.ok && !sent.stale && sent.code === 'invalid_request' && sent.status === undefined
  const tooLargeForConsole = !sent.ok && !sent.stale && sent.status === 413
  if (gateRefused || tooLargeForConsole) {
    const withheld = withheldAfterTransportRefusal(
      body,
      args.facts,
      { ...args.stamp, seq: body.seq + 1 },
      // Why 0 on 413: the console said it is too large, whatever our own budget thinks.
      tooLargeForConsole ? 0 : EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES
    )
    args.reportHealth({ feature: 'transcript_upload', status: 'error', code: withheld.code })
    body = withheld.body
    sha256 = null
    args.commitSeq(body.seq)
    sent = await args.send(body)
  }
  return { sent, sha256 }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** A controller that also aborts when `parent` does (or already did). */
export function linkedAbortController(parent: AbortSignal | null): AbortController {
  const controller = new AbortController()
  if (parent?.aborted) {
    controller.abort()
  } else {
    parent?.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

/** The owner's live credential, or null when it is unavailable, belongs to
 *  someone else, or is no longer current (the owner signed out and back in: a new
 *  sign-in epoch). Every null clears the cache so the next run captures afresh
 *  under whoever is signed in then; the owner itself never changes, so a session
 *  observed under A is only ever sent as A. One capture in flight per session. */
export async function bindSessionPrincipal(
  session: { owner: string | null; principalCapture: Promise<TranscriptPrincipal | null> | null },
  capture: () => Promise<TranscriptPrincipal | null>
): Promise<TranscriptPrincipal | null> {
  if (!session.owner) {
    return null
  }
  session.principalCapture ??= capture().catch(() => null)
  const captured = await session.principalCapture
  if (!captured) {
    session.principalCapture = null
    return null
  }
  if (captured.principal !== session.owner || !captured.isCurrent()) {
    // Someone else, or the owner's earlier sign-in: held now, re-captured next run
    // (A -> B -> A must deliver once A is back, not stay held on the stale capture).
    session.principalCapture = null
    return null
  }
  return captured
}
