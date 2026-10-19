/**
 * Settling a delivery on proof that it already reached its session, instead of holding it as
 * unconfirmable or sending it a second time. Proof is a receipt written at delivery or the
 * delivered text itself as a user turn in the target's transcript; absence of proof never
 * releases a send: only the prompt queue's `unsent` flag does.
 */

import type { WorkHolder, WorkPane } from './work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from './work-delivery-kind'
import { settleDelivered, transcriptProof } from './work-delivery-proof'
import { watchDelivery, type ClaimerLedger } from './work-delivery-watch'

const NOT_CONFIRMED =
  'Whether the session received it cannot be confirmed, so it is not sent a second time.'
const NOT_OPEN =
  'It was already handed to a session that is no longer open, so it is not sent a second time.'

/** Proven received: a live pane still on a turn is followed to `done`, anything else is done now. */
export async function settleProven(
  ledger: ClaimerLedger,
  hostId: string,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  pane: WorkPane | null,
  proof: string
): Promise<void> {
  const typedAlready = delivery.state === 'typed' || delivery.state === 'working'
  if (pane && (await ledger.deps.busy(pane)) === true) {
    if (!typedAlready) {
      await ledger.receipt(hostId, delivery, { state: 'typed' })
    }
    await ledger.receipt(hostId, delivery, { state: 'working' })
    ledger.deps.audit(delivery, `working in pane ${pane.paneKey} (${proof})`)
    watchDelivery(ledger, delivery, target, pane, null, 'working')
    return
  }
  await settleDelivered(ledger, hostId, delivery, `done in ${target.ref} (${proof})`, typedAlready)
}

/**
 * A delivery typed already (a lease that ran out mid-delivery) is only ever followed up, never
 * typed again. True when it was handled here; false when its entry is proven unsent and it goes again.
 */
export async function followHandedOver(
  ledger: ClaimerLedger,
  hostId: string,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  holder: Exclude<WorkHolder, { kind: 'blocked' }>,
  queueId: string
): Promise<boolean> {
  const state = holder.kind === 'live' ? ledger.deps.queueState(holder.pane, queueId) : null
  if (state === 'failed-unsent') {
    return false
  }
  if (holder.kind === 'live' && (state === 'queued' || state === 'delivered')) {
    watchDelivery(
      ledger,
      delivery,
      target,
      holder.pane,
      queueId,
      state === 'delivered' ? 'typed' : 'queued'
    )
    return true
  }
  const proof = await transcriptProof(ledger.deps, delivery, target)
  if (proof) {
    await settleProven(
      ledger,
      hostId,
      delivery,
      target,
      holder.kind === 'live' ? holder.pane : null,
      proof
    )
    return true
  }
  await ledger.hold(
    hostId,
    delivery,
    'unverifiable',
    holder.kind === 'live' ? NOT_CONFIRMED : NOT_OPEN
  )
  return true
}
