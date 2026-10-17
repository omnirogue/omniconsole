import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_BALANCE_MAX_AGE_MS,
  chooseHighestBalanceAccount,
  getAccountBalance
} from './account-balance'
import type { ProviderRateLimits } from './rate-limit-types'

const now = 1_800_000_000_000
function usage(session: number, weekly: number): ProviderRateLimits {
  return {
    provider: 'claude',
    status: 'ok',
    error: null,
    updatedAt: now,
    session: {
      usedPercent: session,
      windowMinutes: 300,
      resetsAt: now + 60_000,
      resetDescription: null
    },
    weekly: {
      usedPercent: weekly,
      windowMinutes: 10080,
      resetsAt: now + 600_000,
      resetDescription: null
    }
  }
}

describe('account balance selection', () => {
  it('chooses usable headroom across both windows, not just weekly allowance', () => {
    expect(
      chooseHighestBalanceAccount(
        [
          { id: 'weekly-rich', rateLimits: usage(99, 5) },
          { id: 'usable', rateLimits: usage(30, 40) }
        ],
        'weekly-rich',
        now
      )
    ).toBe('usable')
  })

  it('uses the saved default for equal balances and stable identity otherwise', () => {
    const accounts = ['b', 'a'].map((id) => ({ id, rateLimits: usage(10, 20) }))
    expect(chooseHighestBalanceAccount(accounts, 'b', now)).toBe('b')
    expect(chooseHighestBalanceAccount(accounts, null, now)).toBe('a')
  })

  it('never treats stale, missing, expired or exhausted readings as spare capacity', () => {
    const stale = { ...usage(0, 0), updatedAt: now - ACCOUNT_BALANCE_MAX_AGE_MS - 1 }
    const expired = usage(0, 0)
    expired.session!.resetsAt = now - 1
    expect(
      chooseHighestBalanceAccount(
        [
          { id: 'unknown', rateLimits: null },
          { id: 'stale', rateLimits: stale },
          { id: 'expired', rateLimits: expired },
          { id: 'out', rateLimits: usage(100, 0) }
        ],
        'stale',
        now
      )
    ).toBeNull()
    expect(getAccountBalance(stale, now).state).toBe('stale')
  })

  it('excludes a failed login even when an old quota is still attached', () => {
    const limits = { ...usage(0, 0), usageMetadata: { failureKind: 'stale-token' as const } }
    expect(getAccountBalance(limits, now).state).toBe('needs-login')
    expect(
      chooseHighestBalanceAccount([{ id: 'bad-auth', rateLimits: limits }], 'bad-auth', now)
    ).toBeNull()
  })

  it('treats a usage 429 without windows as rate-limited, not missing', () => {
    const limits: ProviderRateLimits = {
      provider: 'claude',
      status: 'error',
      error: 'Claude usage is rate limited right now.',
      updatedAt: now,
      session: null,
      weekly: null,
      usageMetadata: { failureKind: 'rate-limited' }
    }
    expect(getAccountBalance(limits, now).state).toBe('rate-limited')
    expect(
      chooseHighestBalanceAccount([{ id: 'limited', rateLimits: limits }], 'limited', now)
    ).toBe(null)
  })

  it('treats a revoked Codex token as needing sign-in', () => {
    const limits: ProviderRateLimits = {
      provider: 'codex',
      status: 'error',
      error:
        'failed to fetch codex rate limits: 401 Unauthorized; body={"error":{"code":"token_revoked"}}',
      updatedAt: now,
      session: null,
      weekly: null
    }
    expect(getAccountBalance(limits, now).state).toBe('needs-login')
  })

  it('includes the Claude model window and preserves unknown as unknown', () => {
    const limits = usage(0, 0)
    limits.fableWeekly = { ...limits.weekly!, usedPercent: 92 }
    expect(getAccountBalance(limits, now).remainingPercent).toBe(8)
    limits.session!.usedPercent = Number.NaN
    expect(getAccountBalance(limits, now).remainingPercent).toBeNull()
  })
})
