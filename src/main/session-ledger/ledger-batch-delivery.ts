import type { LedgerEvent, LedgerEventBatch } from '../../shared/session-ledger-contract'
import type { LedgerSendFailureReason, LedgerSendResult } from './ledger-event-queue'
import { chunkEvents, type QueuedBatch } from './ledger-pending-batches'

export type BatchDeliveryDeps = {
  send(batch: LedgerEventBatch, account: string): Promise<LedgerSendResult>
  currentAccount(): string | null
  warn(message: string): void
}

/**
 * Send one batch as consecutive payloads within the byte cap, in order. Null when every
 * event went out; otherwise the failure and the events (from the failed payload on) still owed.
 * `batch.events` is trimmed as payloads land so a quit spill written mid-batch carries only
 * what has not arrived.
 */
export async function deliverBatch(
  batch: QueuedBatch,
  deps: BatchDeliveryDeps
): Promise<{ reason: LedgerSendFailureReason; remaining: LedgerEvent[] } | null> {
  let remaining = batch.events
  for (const chunk of chunkEvents(batch.envelope, batch.events)) {
    const payload: LedgerEventBatch = { ...batch.envelope, events: chunk }
    let result: LedgerSendResult
    try {
      // Why: the account can flip while an earlier payload is in flight; each one is re-checked
      // here and again inside the transport, which refuses a bearer that is not its account.
      result =
        batch.account === null || batch.account !== deps.currentAccount()
          ? { ok: false, reason: 'principal-mismatch' }
          : await deps.send(payload, batch.account)
    } catch (error) {
      result = { ok: false, reason: 'unavailable' }
      deps.warn(`send threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!result.ok) {
      return { reason: result.reason, remaining }
    }
    remaining = remaining.slice(chunk.length)
    batch.events = remaining
  }
  return null
}
