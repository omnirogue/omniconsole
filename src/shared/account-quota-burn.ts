import type { CapacityWindow } from './provider-account-capacity'
import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'

const MIN_REMAINING_PERCENT = 10
const FIVE_HOUR_HORIZON_MS = 30 * 60_000
const WEEKLY_HORIZON_MS = 6 * 60 * 60_000

type QuotaWindows = {
  fiveHour: CapacityWindow | null | undefined
  weekly: CapacityWindow | null | undefined
}

export type QuotaBurnRisk =
  | {
      window: '5-hour' | 'weekly'
      reason: 'low-reserve'
      minutesToExhaustion: number | null
    }
  | {
      window: '5-hour' | 'weekly'
      reason: 'forecast'
      minutesToExhaustion: number
    }

/** Average burn since this window opened; null when the reset time cannot establish its age. */
export function quotaMinutesToExhaustion(
  window: CapacityWindow,
  readingAt: number,
  now: number
): number | null {
  const duration = window.windowMinutes * 60_000
  const reset = window.resetsAt
  const remaining = window.remainingPercent
  if (
    reset === null ||
    !Number.isFinite(reset) ||
    !Number.isFinite(readingAt) ||
    readingAt > now ||
    reset <= now ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    remaining > 100
  ) {
    return null
  }
  const elapsed = readingAt - (reset - duration)
  const spent = 100 - remaining
  if (elapsed <= 0 || elapsed > duration || spent <= 0) {
    return null
  }
  return (remaining * elapsed) / spent / 60_000
}

export function accountQuotaBurnRisk(
  windows: QuotaWindows,
  readingAt: number | null,
  now: number
): QuotaBurnRisk | null {
  for (const [name, window, horizon] of [
    ['5-hour', windows.fiveHour, FIVE_HOUR_HORIZON_MS],
    ['weekly', windows.weekly, WEEKLY_HORIZON_MS]
  ] as const) {
    if (
      !window ||
      !Number.isFinite(window.remainingPercent) ||
      window.remainingPercent < 0 ||
      window.remainingPercent > 100 ||
      (window.resetsAt !== null && window.resetsAt <= now)
    ) {
      continue
    }
    const minutesToExhaustion =
      readingAt === null ? null : quotaMinutesToExhaustion(window, readingAt, now)
    if (window.remainingPercent <= MIN_REMAINING_PERCENT) {
      return { window: name, reason: 'low-reserve', minutesToExhaustion }
    }
    if (
      minutesToExhaustion !== null &&
      minutesToExhaustion * 60_000 <= horizon &&
      minutesToExhaustion * 60_000 < (window.resetsAt ?? 0) - now
    ) {
      return { window: name, reason: 'forecast', minutesToExhaustion }
    }
  }
  return null
}

function capacityWindow(window: RateLimitWindow | null | undefined): CapacityWindow | null {
  return window &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100
    ? {
        remainingPercent: 100 - window.usedPercent,
        resetsAt: window.resetsAt,
        windowMinutes: window.windowMinutes
      }
    : null
}

export function accountQuotaBurnRiskFromUsage(
  usage: ProviderRateLimits | null | undefined,
  now: number
): QuotaBurnRisk | null {
  if (
    !usage ||
    usage.status !== 'ok' ||
    !Number.isFinite(usage.updatedAt) ||
    usage.updatedAt > now ||
    now - usage.updatedAt > 300_000
  ) {
    return null
  }
  return accountQuotaBurnRisk(
    { fiveHour: capacityWindow(usage.session), weekly: capacityWindow(usage.weekly) },
    usage.updatedAt,
    now
  )
}
