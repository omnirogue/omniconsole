import { buildProviderAccountCapacity } from './provider-account-capacity-builder'
import { describe, expect, it } from 'vitest'
import type { CodexManagedAccount } from './managed-account-types'
import type { ProviderRateLimits, RateLimitState } from './rate-limit-types'
import { chooseAccountForLaunch } from './account-launch-selection'

const now = Date.now()
const limits = (used: number): ProviderRateLimits => ({
  provider: 'codex',
  status: 'ok',
  error: null,
  updatedAt: now,
  session: {
    usedPercent: used,
    windowMinutes: 300,
    resetsAt: now + 600_000,
    resetDescription: null
  },
  weekly: null
})
const accounts = [
  { id: 'default', managedHomePath: '/default' },
  { id: 'spare', managedHomePath: '/spare' },
  { id: 'wsl', managedHomePath: '/wsl', managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
] as CodexManagedAccount[]
const rateLimits = {
  codex: limits(75),
  codexTarget: { runtime: 'host', wslDistro: null },
  inactiveCodexAccounts: [
    { accountId: 'spare', rateLimits: limits(30) },
    { accountId: 'wsl', rateLimits: limits(0) }
  ]
} as RateLimitState

describe('execution-scoped account selection', () => {
  it('uses the highest balance on this runtime without changing the default', () => {
    const args = {
      provider: 'codex' as const,
      accounts,
      defaultAccountId: 'default',
      target: { runtime: 'host' as const, wslDistro: null },
      rateLimits,
      now
    }
    expect(chooseAccountForLaunch(args)?.id).toBe('spare')
    expect(args.defaultAccountId).toBe('default')
  })
  it('does not attribute a different runtime active balance to the default', () => {
    expect(
      chooseAccountForLaunch({
        provider: 'codex',
        accounts,
        defaultAccountId: 'wsl',
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        rateLimits,
        now
      })?.id
    ).toBe('wsl')
  })
  it('can prefer the system account when it has more verified headroom', () => {
    expect(
      chooseAccountForLaunch({
        provider: 'codex',
        accounts,
        defaultAccountId: null,
        target: { runtime: 'host', wslDistro: null },
        rateLimits: { ...rateLimits, codex: limits(0) },
        now
      })
    ).toBeNull()
  })
})

describe('capacity-aware launch fallback and ranking', () => {
  const select = (
    rows: ReturnType<typeof buildProviderAccountCapacity>,
    defaultAccountId: string | null = 'default'
  ) =>
    chooseAccountForLaunch({
      provider: 'codex',
      accounts,
      defaultAccountId,
      target: { runtime: 'host', wslDistro: null },
      now,
      rateLimits: { ...rateLimits, accountCapacity: { claude: [], codex: rows, builtAt: now } }
    })
  const rows = (spareReading?: ProviderRateLimits) =>
    buildProviderAccountCapacity(
      'codex',
      [
        {
          accountId: 'default',
          email: null,
          launchEnv: { CODEX_HOME: '/default' },
          reading: limits(50)
        },
        {
          accountId: 'spare',
          email: null,
          launchEnv: { CODEX_HOME: '/spare' },
          reading: spareReading
        },
        { accountId: null, email: null, launchEnv: { CODEX_HOME: '/system' }, reading: limits(0) }
      ],
      'default',
      now
    )
  it('lets fresh users, API-key users and limited accounts reach the CLI', () => {
    expect(select([])).toBeNull()
    expect(select(rows().map((row) => ({ ...row, state: 'limited' })))).toBeNull()
  })
  it('prefers a measured managed default over an unknown or stale spare and System', () => {
    expect(select(rows())?.id).toBe('default')
    expect(select(rows({ ...limits(0), updatedAt: now - 600_000 }))?.id).toBe('default')
    expect(select(rows(limits(50)))?.id).toBe('default')
    expect(select(rows(limits(10)))?.id).toBe('spare')
  })
  it('uses System when no managed account is usable', () => {
    expect(select(rows().filter((row) => row.isSystem))).toBeNull()
  })
})
