import { isCodexAuthError } from './codex-auth-errors'
import type {
  AccountCapacityRow,
  AccountSignedOutReason,
  CapacityProvider,
  CapacityWindow
} from './provider-account-capacity'
import { accountCapacityChoiceId } from './provider-account-capacity'
import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'

export type AccountCapacityFacts = {
  accountId: string | null
  email: string | null
  detail?: string | null
  launchEnv: Record<string, string> | null
  sourceLabel?: string | null
  signedOutReason?: AccountSignedOutReason
  checking?: boolean
  reading?: ProviderRateLimits | null
}

function windowCapacity(
  window: RateLimitWindow | null | undefined,
  now: number
): CapacityWindow | null {
  if (!window || !Number.isFinite(window.usedPercent)) {
    return null
  }
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return { remainingPercent: 100, resetsAt: null, windowMinutes: window.windowMinutes }
  }
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes
  }
}

export function buildProviderAccountCapacity(
  provider: CapacityProvider,
  facts: readonly AccountCapacityFacts[],
  activeAccountId: string | null,
  now = Date.now()
): AccountCapacityRow[] {
  return facts.map((fact) => {
    const reading = fact.reading
    const fiveHour = windowCapacity(reading?.session, now)
    const weekly = windowCapacity(reading?.weekly, now)
    const exhausted = [fiveHour, weekly].filter(
      (window) => window && window.remainingPercent === 0 && (window.resetsAt ?? 0) > now
    )
    const limitedUntil = exhausted.length
      ? Math.max(...exhausted.map((window) => window!.resetsAt!))
      : null
    const paused =
      reading?.usageMetadata?.source === 'live-session'
        ? null
        : (reading?.usageMetadata?.retryAtMs ?? null)
    const revoked =
      provider === 'codex' &&
      (isCodexAuthError(reading?.error) ||
        /^(auth)$|token_revoked|token has been revoked/i.test(reading?.error ?? ''))
    const launchEnv = revoked ? null : fact.launchEnv
    return {
      provider,
      accountId: fact.accountId,
      choiceId: accountCapacityChoiceId(fact.accountId),
      email: fact.email,
      detail: fact.detail ?? null,
      planType: reading?.planType ?? null,
      isDefault: fact.accountId === activeAccountId,
      isSystem: fact.accountId === null,
      fiveHour,
      weekly,
      fableWeekly: provider === 'claude' ? windowCapacity(reading?.fableWeekly, now) : null,
      availableResetCredits:
        provider === 'codex' &&
        Number.isSafeInteger(reading?.rateLimitResetCredits?.availableCount) &&
        (reading?.rateLimitResetCredits?.availableCount ?? -1) >= 0
          ? reading!.rateLimitResetCredits!.availableCount
          : null,
      state: !launchEnv
        ? fact.checking
          ? 'checking'
          : 'signed-out'
        : limitedUntil
          ? 'limited'
          : reading?.status === 'ok' &&
              now - reading.updatedAt <= 300_000 &&
              !(paused && paused > now)
            ? 'ready'
            : 'usable',
      signedOutReason:
        launchEnv || fact.checking
          ? null
          : revoked
            ? 'revoked'
            : (fact.signedOutReason ?? 'no-login'),
      limitedUntil: launchEnv ? limitedUntil : null,
      readingAt: fiveHour || weekly || reading?.fableWeekly ? (reading?.updatedAt ?? null) : null,
      readingPausedUntil: paused && paused > now ? paused : null,
      sourceLabel: fact.sourceLabel ?? null,
      launchEnv
    }
  })
}
