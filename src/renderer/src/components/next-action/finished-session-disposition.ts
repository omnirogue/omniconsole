import { retrySessionDisposition } from '@/components/next-step/next-step-outcome-client'
import { translate as t } from '@/i18n/i18n'
import {
  getSessionChain,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import type { SessionChain } from '../../../../shared/session-chain-types'

/**
 * A close or save the host gave up on after its bounded retries. The WORK is complete either way
 * (`docs/reference/session-run-lifecycle.md`): this is about the session's window only, so it is
 * never a failure of the run and never something the run "needs" from the person.
 */
export type FailedSessionDisposition = {
  intent: 'close' | 'save'
  /** Why the last try did not happen. A diagnostic: shown under Details only. */
  error?: string
}

export function failedSessionDisposition(
  chain: Pick<SessionChain, 'outcomeSet'> | null | undefined
): FailedSessionDisposition | null {
  const set = chain?.outcomeSet
  const disposition = set?.disposition
  if (
    !set?.completion ||
    !disposition ||
    disposition.state !== 'failed' ||
    disposition.intent === 'completed'
  ) {
    return null
  }
  return {
    intent: disposition.intent,
    ...(disposition.lastError ? { error: disposition.lastError } : {})
  }
}

export function failedDispositionLabel(intent: FailedSessionDisposition['intent']): string {
  return intent === 'save'
    ? t('upNext.dispositionSaveFailed', 'Could not save this session')
    : t('upNext.dispositionCloseFailed', 'Could not close this session')
}

/**
 * The person asks the host for one more bounded series of tries. The host's answer goes straight
 * into the registry, whose subscribers carry out the close or save that is pending again.
 */
export async function retryFinishedSessionDisposition(chain: SessionChain | string): Promise<void> {
  const known = typeof chain === 'string' ? getSessionChain(chain) : chain
  if (!known) {
    throw new Error(
      t(
        'upNext.dispositionRetryUnavailable',
        'This run is not loaded on this device yet. Try again in a moment.'
      )
    )
  }
  setSessionChainEntry(await retrySessionDisposition(known))
  publishSessionChains()
}
