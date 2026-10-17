import { EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES } from '../../shared/employee-transcript-contract'

/**
 * Per-route JSON request budgets. Every workflow body stays under the transport's
 * default 1 MiB except the few that carry a whole file: a returned or added handoff
 * version, a card-less handoff with attachments, and an employee transcript.
 *
 * The transcript budget is the rendered document's own ceiling (8 MiB, enforced
 * first by `renderTranscriptMarkdown`) times the worst JSON escaping of that text:
 * a document of quotes, backslashes and newlines encodes at up to 2× its size.
 */
export const EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES = Math.floor(
  EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES * 2.25
)

const HANDOFF_FILE_REQUEST_MAX_BYTES = 14_100_000

export function consoleWorkflowRequestBudget(path: string): number | undefined {
  if (/\/handoffs\/hth_[A-Za-z0-9_-]+\/files\/upload$/.test(path)) {
    return 36 * 1024 * 1024
  }
  if (
    /\/handoffs\/hth_[A-Za-z0-9_-]+\/files\/(?:return|upload)$/.test(path) ||
    path.endsWith('/api/gtd/hub/api/handoffs') ||
    path === '/api/gtd/hub/api/session-peers/messages'
  ) {
    return HANDOFF_FILE_REQUEST_MAX_BYTES
  }
  if (path === '/api/employee-transcripts') {
    return EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES
  }
  return undefined
}
