/** Bringing back a conversation the person deleted, for one work delivery (split from the claimer). */

import { messageOf } from './work-delivery-claimer-types'
import {
  respawnMayHaveStarted,
  type ClaimableDelivery,
  type WorkDeliveryHeldReason,
  type WorkDeliveryKindAdapter,
  type WorkDeliveryTarget
} from './work-delivery-kind'
import { loginBlocks, type ClaimerLedger } from './work-delivery-watch'

/** The restored target, or null once the delivery was held: a conversation already handed over is
 *  never restored for a second copy, and one its adapter cannot restore stays deleted. */
export async function restoreDeletedTarget(
  ledger: ClaimerLedger,
  hostId: string,
  adapter: WorkDeliveryKindAdapter,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  handedOver: boolean
): Promise<WorkDeliveryTarget | null> {
  const held = async (reason: WorkDeliveryHeldReason, message: string): Promise<null> => {
    await ledger.hold(hostId, delivery, reason, message)
    return null
  }
  if (handedOver || respawnMayHaveStarted(delivery)) {
    return held(
      'unverifiable',
      'It was already handed to a session that is no longer open, so it is not sent a second time.'
    )
  }
  if (!adapter.restoreDeleted || !ledger.deps.restoreDeleted) {
    return held(
      'protection',
      'The person deleted this conversation; it is not brought back without them.'
    )
  }
  const login = await loginBlocks(ledger.deps, target)
  if (login) {
    return held('login_failed', login)
  }
  try {
    await ledger.deps.restoreDeleted(adapter, delivery, target)
  } catch (error) {
    return held('protection', messageOf(error))
  }
  await ledger.receipt(hostId, delivery, { state: 'claimed', step: 'restored' })
  return { ...target, deleted: false }
}
