// Where the delivery guard and the steward find this host's deliverable check: a module slot, so
// neither imports the wiring (and its hook server) just to ask about one conversation.

import type { DeliverableVerifierService } from './deliverable-verifier-service'

let active: DeliverableVerifierService | null = null

export function getDeliverableVerifier(): DeliverableVerifierService | null {
  return active
}

export function setDeliverableVerifier(next: DeliverableVerifierService | null): void {
  active = next
}
