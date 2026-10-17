import type { AppHealthReportInput } from '../../shared/app-health-contract'
import type { EmployeeTranscriptUploadBody } from '../../shared/employee-transcript-contract'
import type {
  SessionTranscriptBuild,
  SessionTranscriptSource
} from './session-transcript-deliverable'
import type { TranscriptSessionScope } from './transcript-session-scope'
import {
  transcriptUploadBody,
  withheldTranscriptBody,
  type TranscriptUploadSessionFacts,
  type TranscriptUploadStamp
} from './transcript-upload-body'
import { ledgerIdForPane } from '../session-ledger/ledger-lookup'

export type TranscriptUploadDecision =
  | { kind: 'send'; body: EmployeeTranscriptUploadBody; sha256: string | null }
  | { kind: 'skip' }

/**
 * What one read becomes: the document, a withheld stub that still records the
 * session, or nothing. A stub always carries a health row saying why. The only
 * silent outcome is an empty session (nothing has been said) or an unchanged
 * checkpoint (the server already holds these bytes).
 */
export function decideTranscriptUpload(args: {
  built: SessionTranscriptBuild
  facts: TranscriptUploadSessionFacts
  stamp: TranscriptUploadStamp
  lastSha256: string | null
  reportHealth: (input: AppHealthReportInput) => void
}): TranscriptUploadDecision {
  const { built, facts, stamp, reportHealth } = args
  const error = (code: string, message?: string): void =>
    reportHealth({
      feature: 'transcript_upload',
      status: 'error',
      code,
      ...(message ? { message } : {})
    })
  if (built.kind === 'built' && (built.earlierMessagesOmitted || built.omittedRecords > 0)) {
    // A partial must never pass as the complete record the server will keep.
    error('incomplete_capture', `${built.omittedRecords || 'earlier'} records omitted`)
    return {
      kind: 'send',
      sha256: null,
      body: withheldTranscriptBody(facts, stamp, {
        kind: 'incomplete_capture',
        omittedRecords: built.omittedRecords,
        earlierMessagesOmitted: built.earlierMessagesOmitted
      })
    }
  }
  if (built.kind === 'built') {
    if (stamp.snapshot === 'checkpoint' && built.deliverable.sha256 === args.lastSha256) {
      return { kind: 'skip' }
    }
    return {
      kind: 'send',
      sha256: built.deliverable.sha256,
      body: transcriptUploadBody(facts, stamp, {
        content: built.deliverable.bytes.toString('utf8'),
        messageCount: built.deliverable.messageCount,
        truncatedBlocks: built.deliverable.truncatedBlocks
      })
    }
  }
  if (built.kind === 'refused') {
    error('protected_data', `${built.redactions} redactions`)
    return {
      kind: 'send',
      sha256: null,
      body: withheldTranscriptBody(facts, stamp, {
        kind: 'protected_data',
        redactions: built.redactions
      })
    }
  }
  if (built.code === 'transcript_too_large') {
    error('too_large', built.sizeBytes ? `${built.sizeBytes} bytes` : undefined)
    return {
      kind: 'send',
      sha256: null,
      body: withheldTranscriptBody(facts, stamp, { kind: 'too_large', bytes: built.sizeBytes })
    }
  }
  if (stamp.snapshot === 'final') {
    // A final with nothing readable (aborted at quit, unflushed or unreadable file)
    // still records that the session existed; the caller retries the real final.
    error('incomplete_capture', built.code)
    return {
      kind: 'send',
      sha256: null,
      body: withheldTranscriptBody(facts, stamp, {
        kind: 'incomplete_capture',
        omittedRecords: 0,
        earlierMessagesOmitted: false,
        readFailed: built.code
      })
    }
  }
  if (built.code !== 'transcript_empty') {
    error(built.code)
  }
  return { kind: 'skip' }
}

/** The transport's own gate refused the document (its redaction pass or size
 *  budget): the same stub the reader's gate would have produced. */
export function withheldAfterTransportRefusal(
  body: EmployeeTranscriptUploadBody,
  facts: TranscriptUploadSessionFacts,
  stamp: TranscriptUploadStamp,
  requestBudgetBytes: number
): { body: EmployeeTranscriptUploadBody; code: 'too_large' | 'protected_data' } {
  const bytes = Buffer.byteLength(JSON.stringify(body))
  return bytes > requestBudgetBytes
    ? {
        code: 'too_large',
        body: withheldTranscriptBody(facts, stamp, { kind: 'too_large', bytes })
      }
    : {
        code: 'protected_data',
        body: withheldTranscriptBody(facts, stamp, { kind: 'protected_data', redactions: 0 })
      }
}

/** Whole session: the source-size gate (16 MiB) bounds it, not this. */
export const TRANSCRIPT_UPLOAD_MAX_MESSAGES = 100_000

/** Read the session whole (tool payloads unclipped) and decide what to send. */
export async function captureAndDecide(args: {
  identity: {
    /** The pane key; names the session-ledger row the transcript is attached to. */
    sessionKey?: string
    agent: string
    sessionId: string
    transcriptPath?: string
    model?: string | null
    cwd?: string | null
  }
  startedAt: string
  scope: TranscriptSessionScope
  snapshot: 'checkpoint' | 'final'
  capturedAt: string
  seq: number
  appVersion: string
  host: string
  lastSha256: string | null
  build: (source: SessionTranscriptSource) => Promise<SessionTranscriptBuild>
  reportHealth: (input: AppHealthReportInput) => void
}): Promise<{
  built: SessionTranscriptBuild
  facts: TranscriptUploadSessionFacts
  stamp: TranscriptUploadStamp
  decision: TranscriptUploadDecision
}> {
  const { identity } = args
  const built = await args.build({
    agent: identity.agent,
    sessionId: identity.sessionId,
    ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
    capturedAt: args.capturedAt,
    model: identity.model ?? null,
    limit: TRANSCRIPT_UPLOAD_MAX_MESSAGES,
    // Whole tool payloads: this is the record, not a handoff summary.
    clipToolPayloads: false
  })
  const facts: TranscriptUploadSessionFacts = {
    agent: identity.agent,
    sessionId: identity.sessionId,
    ledgerId: identity.sessionKey ? ledgerIdForPane(identity.sessionKey) : null,
    model: identity.model ?? null,
    cwd: identity.cwd ?? null,
    startedAt: args.startedAt,
    scope: args.scope
  }
  const stamp: TranscriptUploadStamp = {
    snapshot: args.snapshot,
    seq: args.seq,
    endedAt: args.snapshot === 'final' ? args.capturedAt : null,
    appVersion: args.appVersion,
    host: args.host
  }
  const decision = decideTranscriptUpload({
    built,
    facts,
    stamp,
    lastSha256: args.lastSha256,
    reportHealth: args.reportHealth
  })
  return { built, facts, stamp, decision }
}
