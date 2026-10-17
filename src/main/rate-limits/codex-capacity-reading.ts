import { fetchCodexRateLimitsViaBackend } from './codex-backend-usage-client'
import { emptyReading } from './claude-capacity-reading'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

export async function fetchCodexCapacityEntry(path: string): Promise<ProviderRateLimits> {
  // Imported homes can share a rotating token family even after their tokens diverge.
  return (
    (await fetchCodexRateLimitsViaBackend((url, init) => fetch(url, init), {
      codexHomePath: path,
      requireUnexpiredAccessToken: true
    })) ?? emptyReading('codex')
  )
}
