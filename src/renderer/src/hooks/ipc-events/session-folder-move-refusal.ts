import { ownerPlacedRowRefusal } from '@/lib/mirrored-conversation-row-actions'
import { findManagedSession } from './session-manage-requests'

/**
 * E1 for filing (session parity, Phase 1b): `omni session move` on a row its paired owner places
 * is refused with the sidebar's own words, "Open it on <Computer>", never written into a
 * membership the tree would not show (it reads the owner's folder first). A target no row
 * matches is left to the relay's own "not in the sidebar" answer.
 */
export function refuseOwnerPlacedMove(target: { paneKey?: string; tabId?: string }): void {
  const session = findManagedSession(target)
  const refusal = session ? ownerPlacedRowRefusal(session) : null
  if (refusal) {
    throw new Error(refusal)
  }
}
