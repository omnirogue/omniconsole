import {
  EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES,
  type EmployeeTranscriptSnapshot,
  type EmployeeTranscriptUploadBody
} from '../../shared/employee-transcript-contract'
import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'
import type { TranscriptSessionScope } from './transcript-session-scope'

export type TranscriptUploadSessionFacts = {
  agent: string
  sessionId: string
  /** The pane's session-ledger row (`als_…`), or null when it has none. */
  ledgerId: string | null
  model: string | null
  cwd: string | null
  startedAt: string
  scope: TranscriptSessionScope
}

export type TranscriptUploadStamp = {
  snapshot: EmployeeTranscriptSnapshot
  seq: number
  endedAt: string | null
  appVersion: string
  host: string
}

function baseBody(
  facts: TranscriptUploadSessionFacts,
  stamp: TranscriptUploadStamp
): Omit<EmployeeTranscriptUploadBody, 'content' | 'message_count' | 'truncated_blocks'> {
  return {
    session_id: facts.sessionId,
    // Why: only a well-formed row id travels; the console attaches the transcript to that row.
    ...(facts.ledgerId && LEDGER_ID_PATTERN.test(facts.ledgerId)
      ? { ledger_id: facts.ledgerId }
      : {}),
    agent: facts.agent,
    model: facts.model,
    cwd: facts.cwd,
    company: facts.scope.company,
    domain: facts.scope.domain,
    started_at: facts.startedAt,
    ended_at: stamp.endedAt,
    snapshot: stamp.snapshot,
    seq: stamp.seq,
    app: 'omni-ide',
    app_version: stamp.appVersion,
    host: stamp.host
  }
}

export function transcriptUploadBody(
  facts: TranscriptUploadSessionFacts,
  stamp: TranscriptUploadStamp,
  document: { content: string; messageCount: number; truncatedBlocks: number }
): EmployeeTranscriptUploadBody {
  return {
    ...baseBody(facts, stamp),
    message_count: document.messageCount,
    truncated_blocks: document.truncatedBlocks,
    content: document.content
  }
}

/**
 * What goes up when the redactor refuses the document: the session's existence and
 * shape, never its text. Sal and Uma must still see that the session happened.
 */
export function withheldTranscriptBody(
  facts: TranscriptUploadSessionFacts,
  stamp: TranscriptUploadStamp,
  reason:
    | { kind: 'protected_data'; redactions: number }
    | { kind: 'too_large'; bytes?: number }
    | {
        kind: 'incomplete_capture'
        omittedRecords: number
        earlierMessagesOmitted: boolean
        /** The read itself failed (aborted at quit, unreadable, empty): nothing was captured. */
        readFailed?: string
      }
): EmployeeTranscriptUploadBody {
  const existed = `session existed from ${facts.startedAt} to ${stamp.endedAt ?? 'now (still running)'}, agent ${facts.agent}, cwd ${facts.cwd ?? 'unknown'}`
  if (reason.kind === 'incomplete_capture') {
    const what = reason.readFailed
      ? `read failed (${reason.readFailed})`
      : reason.omittedRecords
        ? `${reason.omittedRecords} record${reason.omittedRecords === 1 ? '' : 's'} omitted`
        : 'earlier messages omitted'
    return {
      ...baseBody(facts, stamp),
      content: `[transcript withheld: incomplete capture — ${what} — ${existed}]`
    }
  }
  const cause =
    reason.kind === 'protected_data'
      ? reason.redactions > 0
        ? `${reason.redactions} protected-data finding${reason.redactions === 1 ? '' : 's'}`
        : 'protected data found by the send gate'
      : `the transcript is above the ${EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES / (1024 * 1024)} MiB limit${reason.bytes ? ` (${reason.bytes} bytes)` : ''}`
  return {
    ...baseBody(facts, stamp),
    content: `[transcript withheld by the IDE redactor: ${cause} — ${existed}]`
  }
}
