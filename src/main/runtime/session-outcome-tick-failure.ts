import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  keepSessionOutcomeBlockSince,
  type SessionOutcomeBlocksBegan
} from './session-outcome-block-since'
import { blockSessionOutcomes } from './session-outcome-hold-write'

/** The two service operations recording a tick failure needs; a narrow shape keeps this leaf-level. */
export type SessionOutcomeTickFailureAccess = {
  get(id: string): SessionChain
  save(chain: SessionChain, expectedRevision: number): SessionChain
}

/**
 * A chain tick that threw left nothing on the record. Block every unsatisfied outcome with the
 * thrown reason so the failure is visible instead of retried in silence. The next tick runs the
 * same pass again by itself, so this is `recovering`: a person can answer nothing here, and a tick
 * that keeps throwing goes stale and reads as failed.
 */
function sessionOutcomeTickFailureSet(
  set: SessionOutcomeSet,
  error: unknown,
  now: number
): SessionOutcomeSet {
  return blockSessionOutcomes(
    set,
    (outcome) => outcome.status !== 'satisfied',
    `Outcome verification failed: ${String(error)}`,
    { class: 'recovering', code: 'tick-error' },
    now
  )
}

/**
 * @param began the blocks the failed pass started with: a pass clears what it cannot re-derive
 * before it runs, so a tick that throws every time would otherwise restart its own clock each time
 * and never be seen to have gone stale.
 */
export function blockOutcomesForTickFailure(
  access: SessionOutcomeTickFailureAccess,
  chainId: string,
  error: unknown,
  now = Date.now(),
  began?: SessionOutcomeBlocksBegan
): void {
  // Read back rather than taken from the pass: its snapshot may be older than what it saved.
  const current = access.get(chainId)
  // A sealed run is proven: a tick that throws afterwards is not about it.
  if (current.outcomeSet!.completion) {
    return
  }
  const blocked = sessionOutcomeTickFailureSet(current.outcomeSet!, error, now)
  access.save(
    { ...current, outcomeSet: began ? keepSessionOutcomeBlockSince(blocked, began) : blocked },
    current.outcomeSet!.revision
  )
}
