import { describe, expect, it, vi } from 'vitest'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import { accountLoginReady, findLoginRow, loginReadinessOf } from './account-login-ready'

const NOW = 1_800_000_000_000
const ACCOUNT_HOME = '/app/claude-accounts/acct-1/auth/session'

function row(overrides: Partial<AccountCapacityRow> = {}): AccountCapacityRow {
  return {
    provider: 'claude',
    accountId: 'acct-1',
    choiceId: 'managed:acct-1',
    email: 'worker@example.com',
    detail: null,
    isDefault: false,
    isSystem: false,
    fiveHour: { remainingPercent: 90, resetsAt: null, windowMinutes: 300 },
    weekly: null,
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: NOW - 30_000,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: { CLAUDE_CONFIG_DIR: ACCOUNT_HOME },
    ...overrides
  }
}

const signedOut = row({
  state: 'signed-out',
  signedOutReason: 'expired',
  launchEnv: null,
  readingAt: null
})

describe('findLoginRow', () => {
  const system = row({
    accountId: null,
    choiceId: 'system',
    isSystem: true,
    launchEnv: { CLAUDE_CONFIG_DIR: '/Users/maintainer/.claude' }
  })
  const rows = { claude: [row(), system], codex: [] }

  it('finds an account by id, choice id or the home it launches', () => {
    expect(findLoginRow(rows, {}, 'acct-1')?.accountId).toBe('acct-1')
    expect(findLoginRow(rows, {}, 'system')?.isSystem).toBe(true)
    expect(
      findLoginRow(rows, {}, { provider: 'claude', home: `${ACCOUNT_HOME}/` })?.accountId
    ).toBe('acct-1')
  })

  it('finds a signed-out managed account from its recorded home, which its row no longer names', () => {
    const managed = {
      claudeManagedAccounts: [{ id: 'acct-1', managedAuthPath: '/app/claude-accounts/acct-1/auth' }]
    }
    const found = findLoginRow({ claude: [signedOut], codex: [] }, managed, {
      provider: 'claude',
      home: ACCOUNT_HOME
    })
    expect(found?.state).toBe('signed-out')
  })

  it('reads the provider default home as the System login, and an unknown home as none', () => {
    expect(
      findLoginRow(rows, {}, { provider: 'claude', home: '/Users/other/.claude' })?.isSystem
    ).toBe(true)
    expect(findLoginRow(rows, {}, { provider: 'claude', home: '/somewhere/else' })).toBeUndefined()
  })
})

describe('loginReadinessOf', () => {
  it('is ready only on a fresh reading taken after the failure', () => {
    expect(loginReadinessOf(row(), { now: NOW, since: NOW - 60_000 })).toEqual({
      ready: true,
      label: 'worker@example.com'
    })
    expect(loginReadinessOf(row(), { now: NOW, since: NOW - 10_000 })).toMatchObject({
      ready: false,
      held: 'login_failed',
      refresh: true
    })
  })

  it('holds a signed-out account as login_failed and a limited one as account_at_limit', () => {
    expect(loginReadinessOf(signedOut, { now: NOW })).toEqual({
      ready: false,
      held: 'login_failed',
      reason: 'worker@example.com is signed out on this computer (sign-in expired)'
    })
    const limited = loginReadinessOf(row({ state: 'limited', limitedUntil: NOW + 3_600_000 }), {
      now: NOW
    })
    expect(limited).toMatchObject({
      ready: false,
      held: 'account_at_limit',
      retryAfter: NOW + 3_600_000
    })
  })

  it('checks again instead of assuming a stale or missing reading works', () => {
    expect(
      loginReadinessOf(row({ state: 'usable', readingAt: NOW - 900_000 }), { now: NOW })
    ).toMatchObject({
      ready: false,
      refresh: true
    })
    expect(loginReadinessOf(undefined, { now: NOW })).toMatchObject({
      ready: false,
      held: 'login_failed'
    })
  })

  it('never puts the login home or any credential in its words', () => {
    const verdicts = [row(), signedOut, row({ state: 'usable', readingAt: null })].map((entry) =>
      JSON.stringify(loginReadinessOf(entry, { now: NOW, since: NOW - 60_000 }))
    )
    for (const text of verdicts) {
      expect(text).not.toContain(ACCOUNT_HOME)
    }
  })
})

describe('accountLoginReady', () => {
  it('asks for a newer reading at most once a minute while it cannot tell', async () => {
    const refresh = vi.fn(async () => {})
    const runtime = {
      getAccountsSnapshot: () =>
        ({
          rateLimits: {
            accountCapacity: { claude: [row({ readingAt: NOW - 900_000 })], codex: [] }
          }
        }) as never,
      refreshAccountsForMobileSubscriber: refresh,
      getAgentAccountSettings: () => ({})
    }
    await expect(accountLoginReady(runtime, 'acct-1', NOW)).resolves.toMatchObject({ ready: false })
    await accountLoginReady(runtime, 'acct-1', NOW + 1_000)
    await accountLoginReady(runtime, 'acct-1', NOW + 61_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('is not ready while account services are not running', async () => {
    const runtime = {
      getAccountsSnapshot: () => {
        throw new Error('account services unavailable')
      },
      refreshAccountsForMobileSubscriber: vi.fn(),
      getAgentAccountSettings: () => ({})
    }
    await expect(accountLoginReady(runtime, 'acct-1', NOW)).resolves.toMatchObject({
      ready: false,
      held: 'login_failed'
    })
  })
})
