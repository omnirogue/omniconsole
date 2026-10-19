/**
 * Proof that a delivery reached its session, and its settling receipts. Proof is a receipt written
 * at delivery or the delivered text itself as a user turn in the target's transcript.
 */

import type { WorkDeliveryDeps } from './work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from './work-delivery-kind'
import type { ClaimerLedger } from './work-delivery-watch'

/** The transcript proof, for kinds that opt in; a read failure is no proof. */
export async function transcriptProof(
  deps: WorkDeliveryDeps,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget
): Promise<string | null> {
  if (!deps.adapters.get(delivery.kind)?.confirmByTranscript || !deps.deliveredInTranscript) {
    return null
  }
  try {
    return await deps.deliveredInTranscript(target, delivery)
  } catch {
    return null
  }
}

/** Reports a delivery that reached its session: `typed` (unless already sent), `working`, `done`. */
export async function settleDelivered(
  ledger: ClaimerLedger,
  hostId: string,
  delivery: ClaimableDelivery,
  summary: string,
  typedAlready: boolean
): Promise<void> {
  ledger.watching.delete(delivery.key)
  if (!typedAlready) {
    await ledger.receipt(hostId, delivery, { state: 'typed' })
  }
  await ledger.receipt(hostId, delivery, { state: 'working' })
  await ledger.receipt(hostId, delivery, { state: 'done' })
  ledger.deps.audit(delivery, summary)
}
