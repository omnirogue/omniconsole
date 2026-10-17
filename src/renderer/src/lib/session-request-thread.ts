import type { HandoffDetail } from '../../../shared/console-handoff-contract'
import {
  SESSION_REQUEST_ACTION,
  parseSessionRequestBody,
  type SessionRequest
} from '../../../shared/session-request'

/**
 * Whether a thread the person is looking at is somebody asking for their session.
 *
 * The request lives in the thread's opening entry, which is the body the author sent. Only a
 * thread whose action is the one a request uses is even examined, so an ordinary note that happens
 * to quote the marker cannot turn ✓ Done into a handover.
 */
function openingBody(detail: HandoffDetail): string | null {
  const first = detail.entries.at(0)
  return first ? first.body : null
}

export function sessionRequestBodyOf(detail: HandoffDetail): string | null {
  if (detail.thread.action !== SESSION_REQUEST_ACTION) {
    return null
  }
  const body = openingBody(detail)
  return body && parseSessionRequestBody(body) ? body : null
}

export function sessionRequestOf(detail: HandoffDetail): SessionRequest | null {
  const body = sessionRequestBodyOf(detail)
  return body ? parseSessionRequestBody(body) : null
}
