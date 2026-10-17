import type { GlobalSettings } from './global-settings-types'

/** Agents one outcome chain may run at once when the person authored that work as parallel. */
export const OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT = 3
export const OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MIN = 1
export const OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MAX = 8

/**
 * No setting means the person never chose, so the default applies. A present but malformed one
 * fails CLOSED to the minimum: a corrupt or version-skewed value is not authority to run more
 * agents. A whole number outside the range is clamped, so no setting can remove the cap.
 */
export function resolveOutcomeChainMaxConcurrentAgents(
  settings: Pick<GlobalSettings, 'outcomeChainMaxConcurrentAgents'> | null | undefined
): number {
  const raw = settings?.outcomeChainMaxConcurrentAgents
  if (raw === undefined) {
    return OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MIN
  }
  return Math.min(
    OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MAX,
    Math.max(OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MIN, raw)
  )
}

/**
 * A chain admitted under a card shares one immutable projection, and a native continuation chains
 * every dispatch on the previous one: both run one agent at a time whatever the setting says.
 * Filing an outcome under a card by `taskRef` is not admission and changes nothing here — and
 * neither is a `same-session` step, which continues a conversation without admitting anything.
 */
export function outcomeChainCardBound(
  continuation: { taskId?: string; nativeSource?: unknown } | undefined
): boolean {
  return Boolean(continuation?.taskId || continuation?.nativeSource)
}

/** How a chain's capacity reads for the person. */
export function outcomeChainCapacityLabel(limit: number, cardBound: boolean): string {
  if (cardBound) {
    return '1 at a time · card-bound'
  }
  return limit <= 1 ? '1 at a time' : `up to ${limit} at a time`
}
