import {
  LAUNCH_REFERENCE_KEYS,
  type LaunchCause,
  type LaunchReference
} from '../../shared/launch-cause'
import { isLaunchTrigger } from '../../shared/launch-trigger'
import { hashLaunchCorrelationId } from './launch-ledger-identifiers'

/** Caller declarations are evidence, never host authority or readable owner text. */
export function callerLaunchClaims(
  value: unknown
): Pick<LaunchCause, 'claimedTrigger' | 'claimedTriggerHash' | 'claimedReferenceHashes'> {
  try {
    if (!value || typeof value !== 'object') {
      return {}
    }
    const input = value as { trigger?: unknown; reference?: unknown }
    const claims: Pick<
      LaunchCause,
      'claimedTrigger' | 'claimedTriggerHash' | 'claimedReferenceHashes'
    > = {}
    if (isLaunchTrigger(input.trigger)) {
      claims.claimedTrigger = input.trigger
    } else if (typeof input.trigger === 'string') {
      claims.claimedTriggerHash = hashLaunchCorrelationId(input.trigger)
    }
    if (input.reference && typeof input.reference === 'object') {
      const reference: LaunchReference = {}
      for (const key of LAUNCH_REFERENCE_KEYS) {
        const id = (input.reference as Record<string, unknown>)[key]
        if (typeof id === 'string') {
          reference[key] = `hash_${hashLaunchCorrelationId(id).slice(0, 12)}`
        }
      }
      if (Object.keys(reference).length) {
        claims.claimedReferenceHashes = reference
      }
    }
    return claims
  } catch {
    return {}
  }
}
