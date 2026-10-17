import { observeSessionOutcomeSource, type SourceObservation } from './session-outcome-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

/**
 * Whether the source may be treated as finished, now.
 *
 * Planning provenance says which session is the source, never that it finished, so readiness
 * always comes from a fresh observation. A stored `true` survives only loss of contact: a
 * definite observation ("still running") replaces it, so a wrong value can be repaired.
 */
export async function resolveSessionOutcomeSourceReadiness(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  options?: { successfulOnly?: boolean }
): Promise<SourceObservation> {
  const stored = chain.outcomeSet?.continuation
  const observed = await observeSessionOutcomeSource(runtime, chain, options)
  if (observed.ready || !stored?.sourceReady || !observed.unverifiable) {
    return observed
  }
  return {
    ready: true,
    unverifiable: true,
    ...(stored.sourceVersion ? { version: stored.sourceVersion } : {})
  }
}
