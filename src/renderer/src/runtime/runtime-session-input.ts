/**
 * Client side of the host's per-session input queue.
 *
 * A caller that can reach the queue hands over the whole sequence and gets a
 * receipt. A caller that cannot — a remote runtime whose host predates the queue
 * — keeps its own byte writes; `canSubmitRuntimeSessionInput` is how each caller
 * asks, so the legacy sequence stays in one place instead of being duplicated.
 */

import type {
  SessionInputOrigin,
  SessionInputReceipt,
  SessionInputSubmission
} from '../../../shared/session-input-program'
import { isSessionInputDeliveredStatus } from '../../../shared/session-input-program'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

type SessionInputApi = {
  submitSessionInput?: (submission: SessionInputSubmission) => Promise<SessionInputReceipt>
  cancelSessionInput?: (
    ptyId: string,
    filter?: { clientMessageId?: string; origin?: SessionInputOrigin }
  ) => Promise<boolean>
}

function sessionInputApi(): SessionInputApi | null {
  const api = (globalThis as { window?: { api?: { pty?: SessionInputApi } } }).window?.api?.pty
  return api ?? null
}

/**
 * True when this PTY's bytes are written by the host that owns this queue. A
 * remote-runtime PTY is written by ITS host, which needs its own queue entry
 * point, so those sends stay on the existing path until that lands.
 */
export function canSubmitRuntimeSessionInput(ptyId: string): boolean {
  // Why the id decides: a remote-runtime PTY id carries the owning environment and
  // handle, and those bytes are written by THAT host — which needs its own queue
  // entry point before these sends can be handed over.
  if (parseRemoteRuntimePtyId(ptyId) !== null) {
    return false
  }
  return typeof sessionInputApi()?.submitSessionInput === 'function'
}

/** Null when the queue could not be reached at all — the caller must fall back. */
export async function submitRuntimeSessionInput(
  submission: SessionInputSubmission
): Promise<SessionInputReceipt | null> {
  const submit = sessionInputApi()?.submitSessionInput
  if (typeof submit !== 'function') {
    return null
  }
  try {
    return await submit(submission)
  } catch {
    // Why: a refused or dropped IPC is not a delivery; the caller reports failure
    // rather than silently re-writing bytes the queue may already have written.
    return {
      clientMessageId: submission.clientMessageId,
      status: 'failed',
      errorCode: 'session_input_unavailable'
    }
  }
}

/**
 * Best-effort cancellation for callers that do not require an acknowledgement.
 * Pass a filter to leave other callers' items alone.
 */
export async function cancelRuntimeSessionInput(
  ptyId: string,
  filter?: { clientMessageId?: string; origin?: SessionInputOrigin }
): Promise<void> {
  await cancelRuntimeSessionInputVerified(ptyId, filter)
}

/** Stop controls must not overtake a queue whose cancellation was unconfirmed. */
export async function cancelRuntimeSessionInputVerified(
  ptyId: string,
  filter?: { clientMessageId?: string; origin?: SessionInputOrigin }
): Promise<boolean> {
  // These sends use the renderer queue, never this client's host program queue.
  if (parseRemoteRuntimePtyId(ptyId) !== null) {
    return true
  }
  const cancel = sessionInputApi()?.cancelSessionInput
  if (typeof cancel !== 'function') {
    return false
  }
  try {
    return (await cancel(ptyId, filter)) === true
  } catch {
    return false
  }
}

export function wasRuntimeSessionInputDelivered(receipt: SessionInputReceipt | null): boolean {
  return receipt !== null && isSessionInputDeliveredStatus(receipt.status)
}
