import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AccountCapacityRow } from '../../../../shared/provider-account-capacity'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { AccountBalanceList } from './AccountBalanceList'

const { localRates } = vi.hoisted(() => ({ localRates: { current: {} as RateLimitState } }))
vi.mock('../../store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ rateLimits: localRates.current })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, unknown> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(values[key] ?? ''))
}))

function model(): AccountsPaneSectionModel {
  const accounts = Array.from({ length: 7 }, (_, index) => ({
    id: `c${index}`,
    email: `account${index}@example.com`
  }))
  return {
    settings: {},
    isRemoteAccountScope: false,
    accountRuntime: { runtime: 'host', label: 'This Mac' },
    claudeAccounts: { accounts, activeAccountId: 'c0' },
    visibleClaudeAccounts: accounts,
    claudeAction: 'idle'
  } as unknown as AccountsPaneSectionModel
}

describe('compact account balance list', () => {
  it('shows every account, the chosen default and per-account balances', () => {
    const limits = {
      provider: 'claude' as const,
      status: 'ok' as const,
      error: null,
      updatedAt: Date.now(),
      session: {
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: Date.now() + 600_000,
        resetDescription: null
      },
      weekly: null
    }
    localRates.current = {
      claude: limits,
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [
        {
          accountId: 'c1',
          rateLimits: { ...limits, session: { ...limits.session, usedPercent: 65 } }
        }
      ]
    } as RateLimitState
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={model()} />)
    for (let index = 0; index < 7; index++) {
      expect(html).toContain(`account${index}@example.com`)
    }
    expect(html).toContain('90% left')
    expect(html).toContain('35% left')
    expect(html).toContain('Usage unavailable')
    expect(html).toContain('>Default<')
    expect(html).toContain('Make default')
  })

  it('never labels a remote account using the desktop balance', () => {
    const remote = { ...model(), isRemoteAccountScope: true, accountRateLimits: null }
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={remote} />)
    expect(html).not.toContain('90% left')
    expect(html).toContain('Usage unavailable')
  })

  it('renders sorted capacity identities and picks up a replacement snapshot', () => {
    const system: AccountCapacityRow = {
      provider: 'claude',
      accountId: null,
      choiceId: 'system',
      email: 'system@example.com',
      detail: null,
      isDefault: false,
      isSystem: true,
      fiveHour: null,
      weekly: null,
      fableWeekly: null,
      state: 'checking',
      signedOutReason: null,
      limitedUntil: null,
      readingAt: null,
      readingPausedUntil: null,
      sourceLabel: null,
      launchEnv: null
    }
    const managed = {
      ...system,
      accountId: 'c0',
      choiceId: 'managed:c0',
      email: 'capacity@example.com',
      isSystem: false,
      isDefault: true
    }
    const snapshot = { claude: [system, managed], codex: [], builtAt: Date.now() }
    localRates.current = { accountCapacity: snapshot } as unknown as RateLimitState
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={model()} />)
    expect(html).toContain('system@example.com')
    expect(html).toContain('Checking usage…')
    expect(html).not.toContain('account0@example.com')
    expect(html).not.toContain('Usage unavailable')
    expect(html.indexOf('capacity@example.com')).toBeLessThan(html.indexOf('system@example.com'))
    localRates.current = {
      accountCapacity: { ...snapshot, claude: [{ ...system, state: 'usable' }] }
    } as unknown as RateLimitState
    const updated = renderToStaticMarkup(<AccountBalanceList provider="claude" model={model()} />)
    expect(updated).toContain('Ready · usage not read yet')
    expect(updated).not.toContain('Checking usage…')
    expect(updated).not.toContain('capacity@example.com')
  })

  it('uses an empty capacity snapshot instead of synthesizing legacy rows', () => {
    localRates.current = {
      accountCapacity: { claude: [], codex: [], builtAt: Date.now() }
    } as unknown as RateLimitState
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={model()} />)
    expect(html).not.toContain('Usage unavailable')
    expect(html).not.toContain('account0@example.com')
    expect(html).not.toContain('System login')
  })

  it('keeps the remote legacy fallback even when local capacity is present', () => {
    localRates.current = {
      accountCapacity: { claude: [], codex: [], builtAt: Date.now() }
    } as unknown as RateLimitState
    const remote = { ...model(), isRemoteAccountScope: true, accountRateLimits: null }
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={remote} />)
    expect(html).toContain('account0@example.com')
    expect(html).toContain('Usage unavailable')
  })

  it('names a usage 429 instead of hiding it as unavailable', () => {
    localRates.current = {
      claude: {
        provider: 'claude',
        status: 'ok',
        error: null,
        updatedAt: Date.now(),
        session: {
          usedPercent: 10,
          windowMinutes: 300,
          resetsAt: Date.now() + 600_000,
          resetDescription: null
        },
        weekly: null
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [
        {
          accountId: 'c1',
          rateLimits: {
            provider: 'claude',
            status: 'error',
            error: 'Claude usage is rate limited right now.',
            updatedAt: Date.now(),
            session: null,
            weekly: null,
            usageMetadata: { failureKind: 'rate-limited' }
          }
        }
      ]
    } as RateLimitState
    const html = renderToStaticMarkup(<AccountBalanceList provider="claude" model={model()} />)
    expect(html).toContain('Rate limited')
    expect(html).toContain('90% left')
  })
})
