import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'

export const ACCOUNT_BALANCE_MAX_AGE_MS = 30 * 60 * 1000

export type AccountBalance = {
  remainingPercent: number | null
  state: 'ready' | 'exhausted' | 'stale' | 'unknown' | 'needs-login' | 'rate-limited'
  resetsAt: number | null
}

const SIGN_IN_FAILURE_KINDS = new Set(['missing-credentials', 'stale-token', 'missing-scope'])

function requiresSignIn(limits: ProviderRateLimits): boolean {
  if (SIGN_IN_FAILURE_KINDS.has(limits.usageMetadata?.failureKind ?? '')) {
    return true
  }
  return /token_revoked|No credentials/i.test(limits.error ?? '')
}

/** The most constrained window determines whether a new session has room to run. */
export function getAccountBalance(
  limits: ProviderRateLimits | null | undefined,
  now = Date.now()
): AccountBalance {
  const unknown: AccountBalance = { remainingPercent: null, state: 'unknown', resetsAt: null }
  if (!limits) {
    return unknown
  }
  if (requiresSignIn(limits)) {
    return { ...unknown, state: 'needs-login' }
  }
  const windows = [limits.session, limits.weekly, limits.fableWeekly, limits.monthly].filter(
    (window): window is RateLimitWindow => window != null
  )
  if (
    windows.length === 0 ||
    windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0)
  ) {
    if (limits.usageMetadata?.failureKind === 'rate-limited') {
      return { ...unknown, state: 'rate-limited' }
    }
    return unknown
  }
  const tightest = windows.reduce((a, b) => (a.usedPercent >= b.usedPercent ? a : b))
  const remainingPercent = Math.max(0, 100 - tightest.usedPercent)
  const stale =
    limits.status !== 'ok' ||
    !Number.isFinite(limits.updatedAt) ||
    limits.updatedAt > now ||
    now - limits.updatedAt > ACCOUNT_BALANCE_MAX_AGE_MS ||
    windows.some((window) => window.resetsAt !== null && window.resetsAt <= now)
  return {
    remainingPercent,
    state: stale ? 'stale' : remainingPercent > 0 ? 'ready' : 'exhausted',
    resetsAt: tightest.resetsAt
  }
}

export type AccountBalanceCandidate = {
  id: string
  rateLimits: ProviderRateLimits | null | undefined
}

/** Callers supply only accounts on the execution host and in the requested runtime. */
export function chooseHighestBalanceAccount(
  accounts: readonly AccountBalanceCandidate[],
  defaultAccountId: string | null | undefined,
  now = Date.now()
): string | null {
  const eligible = accounts
    .map((account) => ({ ...account, balance: getAccountBalance(account.rateLimits, now) }))
    .filter((account) => account.balance.state === 'ready')
    .sort((a, b) => {
      const difference = b.balance.remainingPercent! - a.balance.remainingPercent!
      if (difference) {
        return difference
      }
      if (a.id === defaultAccountId) {
        return -1
      }
      if (b.id === defaultAccountId) {
        return 1
      }
      return a.id.localeCompare(b.id)
    })
  return eligible[0]?.id ?? null
}
