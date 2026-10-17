import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeVerification } from './session-outcome-evidence'
import { observeSessionOutcomeSource } from './session-outcome-source'

/**
 * A reading that observed NOTHING about the source: its pane or host is out of contact (or the pane
 * exited, which a finish receipt cannot count), or the live pane has not been quiet long enough to
 * say. It refuses new proof and contradicts none already earned.
 */
export type InconclusiveSessionOutcomeVerification = {
  verified: false
  reason: string
  inconclusive: 'lost-contact' | 'settling'
}

/** Why a reading observed nothing, or undefined for a definite one (verified, or refused on evidence). */
export function inconclusiveSessionOutcomeVerification(
  result: SessionOutcomeVerification
): InconclusiveSessionOutcomeVerification['inconclusive'] | undefined {
  const kind = result.verified
    ? undefined
    : (result as Partial<InconclusiveSessionOutcomeVerification>).inconclusive
  return kind === 'lost-contact' || kind === 'settling' ? kind : undefined
}

/** Only a definite reading (the source ran again, asked, failed, changed) may spend earned proof. */
export function isInconclusiveSessionOutcomeVerification(
  result: SessionOutcomeVerification
): boolean {
  return inconclusiveSessionOutcomeVerification(result) !== undefined
}

export async function verifySessionOutcomeSession(
  condition: SessionOutcomeCondition,
  runtime?: OrcaRuntimeService,
  chain?: SessionChain
): Promise<SessionOutcomeVerification | InconclusiveSessionOutcomeVerification> {
  if (!runtime || !chain?.outcomeSet || condition.target !== chain.sourcePaneKey) {
    return { verified: false, reason: 'The session finish needs its exact execution-host source.' }
  }
  const source = await observeSessionOutcomeSource(runtime, chain, { successfulOnly: true })
  if (source.ready && source.version) {
    return {
      verified: true,
      version: source.version,
      receipt: `session:${chain.sourcePaneKey}:${source.version}`
    }
  }
  const reason = source.reason ?? 'Waiting for the source session to finish.'
  if (source.unverifiable) {
    return { verified: false, reason, inconclusive: 'lost-contact' }
  }
  return source.settling
    ? { verified: false, reason, inconclusive: 'settling' }
    : { verified: false, reason }
}
