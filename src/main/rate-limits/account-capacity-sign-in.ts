import type { CapacityProvider } from '../../shared/provider-account-capacity'
import type { CapacityEntry } from './claude-capacity-reading'
import type { AccountCapacityReadings } from './account-capacity-readings'

export function clearSignedInCapacityReadings(
  provider: CapacityProvider,
  accountId: string | undefined,
  previous: CapacityEntry[],
  current: CapacityEntry[],
  readings: AccountCapacityReadings,
  attempted: Map<string, number>
): Set<string> {
  const previousIds = new Set(previous.map((entry) => entry.accountId))
  const ids = new Set(
    accountId
      ? [accountId]
      : current.flatMap((entry) =>
          entry.accountId && !previousIds.has(entry.accountId) ? [entry.accountId] : []
        )
  )
  for (const entry of [...previous, ...current]) {
    if (!entry.accountId || !ids.has(entry.accountId)) {
      continue
    }
    const key = JSON.stringify([provider, entry.path])
    if ((readings.get(key)?.usageMetadata?.retryAtMs ?? 0) > Date.now()) {
      continue
    }
    readings.delete(key)
    attempted.delete(key)
    entry.reading = null
  }
  return ids
}
