import type { SessionChain } from '../../shared/session-chain-types'
import { isSettledSessionRun, readSessionRun } from '../../shared/session-run-lifecycle'
import { isFinishedOutcomeChain } from './session-outcome-source-uniqueness'

/** Why the host was asked to converge now instead of at its next cadence. */
export type SessionOutcomeReconcileReason =
  | 'startup'
  | 'continuation'
  | 'commit'
  | 'worker-exit'
  | 'refresh'
  | 'watchdog'

/**
 * Whether a FINISHED run's persisted record contradicts what the record itself proves: complete
 * but not recorded as done, or complete but never sealed. Such a run has no work left, so the tick
 * would skip it for ever; one cheap save repairs it. A cancelled run was stopped on purpose and a
 * quarantined one cannot be read, so neither is anybody's to repair.
 */
export function finishedSessionOutcomeNeedsRepair(chain: SessionChain, now: number): boolean {
  const set = chain.outcomeSet
  if (!set || chain.state === 'cancelled' || chain.quarantine) {
    return false
  }
  if (set.completion) {
    return chain.state !== 'done'
  }
  const run = readSessionRun(set, { now, planVersion: chain.planVersion ?? 1 })
  // Proven with stages still ahead is unfinished work: the ordinary tick owns it.
  return run.phase === 'completed' && chain.currentIndex >= chain.steps.length
}

/**
 * Whether an UNFINISHED run is persisted under a state its own reading contradicts (failed work
 * recorded as waiting, or the reverse). The tick may have had nothing to write, so nothing else
 * would correct it.
 */
export function sessionOutcomeStateDisagrees(chain: SessionChain, now: number): boolean {
  const set = chain.outcomeSet
  if (!set || set.completion || chain.state === 'cancelled' || chain.quarantine) {
    return false
  }
  const run = readSessionRun(set, { now, planVersion: chain.planVersion ?? 1 })
  if (run.phase === 'completed') {
    return chain.currentIndex >= chain.steps.length
  }
  return chain.state !== (run.phase === 'failed' ? 'failed' : 'waiting')
}

/** What the tick does with a chain: advance its work, repair its finished record, or leave it. */
export function sessionOutcomeTickDuty(
  chain: SessionChain,
  now: number
): 'advance' | 'repair' | 'skip' {
  if (!chain.outcomeSet || chain.quarantine) {
    return 'skip'
  }
  if (!isFinishedOutcomeChain(chain)) {
    return 'advance'
  }
  return finishedSessionOutcomeNeedsRepair(chain, now) ? 'repair' : 'skip'
}

/**
 * Runs a headless host must stay alive for after the desktop quits. A sealed run is finished and a
 * failed one will not move by itself, so neither may relaunch the background host for ever.
 */
export function pendingSessionOutcomeChains(
  chains: readonly SessionChain[],
  now: number
): SessionChain[] {
  return chains.filter(
    (chain) =>
      chain.outcomeSet &&
      !chain.quarantine &&
      !isFinishedOutcomeChain(chain) &&
      !isSettledSessionRun(
        readSessionRun(chain.outcomeSet, { now, planVersion: chain.planVersion ?? 1 })
      )
  )
}
