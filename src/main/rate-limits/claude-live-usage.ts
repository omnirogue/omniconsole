import type { ProviderRateLimits } from '../../shared/rate-limit-types'
export const LIVE_CLAUDE_INGEST_DEDUPE_MS = 30 * 1000
export function normalizeClaudeConfigDir(dir: string | null | undefined): string | null {
  // Why: normalize mixed Windows separators for path attribution; preserve Linux case sensitivity.
  const trimmed = dir?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed || null
}

export function isSameUsageWindow(
  a: ProviderRateLimits['session'],
  b: ProviderRateLimits['session']
): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt
}
