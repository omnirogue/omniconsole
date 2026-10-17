import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  employeeTranscriptUploadAnswer,
  type EmployeeTranscriptUploadAnswer,
  type EmployeeTranscriptUploadBody
} from '../../shared/employee-transcript-contract'
import {
  captureConsoleWorkflowPerson,
  currentConsolePublicationScope
} from './console-workflow-person'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/**
 * Upload one session snapshot. JSON, not multipart: the BFF route takes `content` in
 * the body, and the transport's per-route budget admits the transcript's 8 MiB ceiling.
 * The transport's own redaction pass still runs over the body, so a transcript that
 * carries the live bearer is refused here even after the deliverable gate passed.
 */
export function uploadEmployeeTranscript(
  body: EmployeeTranscriptUploadBody,
  options: {
    timeoutMs: number
    signal?: AbortSignal
    expectedPrincipal?: string
    expectedPersonIsCurrent?: () => boolean
  }
): Promise<ConsoleWorkflowResult<EmployeeTranscriptUploadAnswer>> {
  // Why all three: the timeout bounds a normal upload; the signal is the quit deadline
  // shared by capture, auth and fetch; the principal fence refuses to send one person's
  // session under another's credential after an account switch.
  return request(
    '/api/employee-transcripts',
    'POST',
    employeeTranscriptUploadAnswer,
    body,
    options.timeoutMs,
    false,
    options.expectedPrincipal,
    options.expectedPersonIsCurrent,
    options.signal
  )
}

/** The signed-in person's principal without touching the credential: identity only. */
export function currentTranscriptOwner(): string | null {
  return currentConsolePublicationScope()?.principal ?? null
}

/** Who is signed in right now, with a live credential, for the send fence. */
export async function captureTranscriptPrincipal(): Promise<{
  principal: string
  isCurrent: () => boolean
} | null> {
  const captured = await captureConsoleWorkflowPerson()
  return captured.ok
    ? { principal: captured.data.principal, isCurrent: captured.data.isCurrent }
    : null
}
