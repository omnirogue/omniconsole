import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeHasWaits } from '../../shared/session-outcome-waits-summary'

let listener: ((chain: SessionChain) => void) | null = null

/** Where a saved plan's waits go next (omnios, `console-session-waits.ts`); none on a bare host. */
export function installSessionOutcomeWaitsListener(next: typeof listener): void {
  listener = next
}

/** Called after every durable save; a listener failure never reaches the terminal writer. */
export function noteSessionOutcomeSaved(chain: SessionChain): void {
  if (!listener || !sessionOutcomeHasWaits(chain)) {
    return
  }
  try {
    listener(chain)
  } catch (error) {
    console.warn('[outcomes] could not pass waits on', chain.id, error)
  }
}
