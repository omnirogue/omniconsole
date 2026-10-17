/** What a queued item's delivery may do: write bytes, wait, and check it still owns the session. */

import type {
  SessionInputCancelReason,
  SessionInputOrigin
} from '../../../shared/session-input-program'

export type SessionInputDeliveryContext = {
  ptyId: string
  origin: SessionInputOrigin
  clientMessageId: string
  /** Refuses once the item is cancelled: no byte can reach a target it no longer owns. */
  write: (data: string) => Promise<boolean>
  /** Cancellable gap. Rejects the moment the item is cancelled. */
  pause: (ms: number) => Promise<void>
  /** Aborts on cancellation, so a delivery's own waits can be cut short. */
  signal: AbortSignal
  assertActive: () => void
}

/** Thrown into a delivery when its session rebound, exited, or the caller cancelled. */
export class SessionInputCancelledError extends Error {
  readonly reason: SessionInputCancelReason

  constructor(reason: SessionInputCancelReason) {
    super('session_input_cancelled')
    this.name = 'SessionInputCancelledError'
    this.reason = reason
  }
}

export function isSessionInputCancelledError(error: unknown): error is SessionInputCancelledError {
  return error instanceof SessionInputCancelledError
}
