// @vitest-environment happy-dom
import { cleanup, fireEvent, render as renderDom, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountCapacityRow as CapacityRow } from '../../../../shared/provider-account-capacity'
import {
  capacityWindowLines,
  formatCapacityCompact,
  formatCapacityResetTime
} from '@/lib/account-capacity-format'
import { AccountCapacityRow } from './AccountCapacityRow'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, unknown> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(values[key] ?? ''))
}))

const readingAt = Date.now()
const reset = readingAt + 600_000
function row(overrides: Partial<CapacityRow> = {}): CapacityRow {
  return {
    provider: 'claude',
    accountId: 'a',
    choiceId: 'managed:a',
    email: 'a@example.com',
    detail: 'Workspace A',
    isDefault: false,
    isSystem: false,
    fiveHour: { remainingPercent: 82, resetsAt: reset, windowMinutes: 300 },
    weekly: { remainingPercent: 64, resetsAt: reset, windowMinutes: 10080 },
    fableWeekly: { remainingPercent: 45, resetsAt: reset, windowMinutes: 10080 },
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt,
    readingPausedUntil: null,
    sourceLabel: '~/.claude-account-5',
    launchEnv: null,
    ...overrides
  }
}
function accountModel(overrides: Partial<AccountsPaneSectionModel> = {}): AccountsPaneSectionModel {
  return {
    claudeAction: 'idle',
    codexAction: 'idle',
    accountRuntime: { runtime: 'host', label: 'Local computer' },
    accountRuntimeSentenceLabel: 'this computer',
    ...overrides
  } as AccountsPaneSectionModel
}
function render(capacity: CapacityRow, model = accountModel()): string {
  return renderToStaticMarkup(
    <AccountCapacityRow row={capacity} model={model} select={vi.fn()} signIn={vi.fn()} />
  )
}

afterEach(cleanup)

describe('account capacity row', () => {
  it('renders every ready window in contract order, identity, source and reading time', () => {
    const capacity = row()
    const html = render(capacity)
    const lines = capacityWindowLines(capacity)
    for (const line of lines) {
      expect(html).toContain(line)
    }
    expect(html.indexOf(lines[0])).toBeLessThan(html.indexOf(lines[1]))
    expect(html.indexOf(lines[1])).toBeLessThan(html.indexOf(lines[2]))
    expect(html).toContain('a@example.com')
    expect(html).toContain('Workspace A')
    expect(html).toContain('via ~/.claude-account-5')
    expect(html).toContain(
      `Updated ${new Date(readingAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    )
    expect(html).not.toContain('Usage unavailable')
    expect(html).toContain('Make default')
  })

  it.each([
    ['limited', { limitedUntil: reset }, `Rate limited until ${formatCapacityResetTime(reset)}`],
    ['limited', {}, 'Rate limited'],
    ['usable', { readingAt: null }, 'Ready · usage not read yet'],
    [
      'usable',
      {},
      `Ready · last updated ${new Date(readingAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    ],
    [
      'usable',
      { readingPausedUntil: reset },
      `Ready · usage reading paused until ${formatCapacityResetTime(reset)}`
    ],
    ['checking', {}, 'Checking usage…'],
    ['signed-out', { signedOutReason: 'expired' }, 'Needs sign-in']
  ] as const)('renders %s from the contract state', (state, extra, expected) => {
    const html = render(row({ state, ...extra }))
    expect(html).toContain(expected)
    if (state === 'signed-out') {
      expect(html).toContain('Sign-in status: The saved sign-in expired')
      expect(html).toContain('>Sign in<')
    }
  })

  it('keeps the System identity and default selection without a removal menu', () => {
    const system = row({
      isSystem: true,
      accountId: null,
      choiceId: 'system',
      email: 'system@example.com'
    })
    const html = render(system)
    expect(html).toContain('System login')
    expect(html).toContain('system@example.com')
    expect(html).toContain('Make default')
    expect(html).not.toContain('Manage')
    const select = vi.fn()
    const view = renderDom(
      <AccountCapacityRow row={system} model={accountModel()} select={select} signIn={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }))
    expect(select).toHaveBeenCalledWith(null)
    view.rerender(
      <AccountCapacityRow
        row={{ ...system, isDefault: true }}
        model={accountModel()}
        select={select}
        signIn={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull()
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull()
  })

  it('disables default selection for a signed-out managed account', () => {
    const select = vi.fn()
    renderDom(
      <AccountCapacityRow
        row={row({ state: 'signed-out', signedOutReason: 'expired' })}
        model={accountModel()}
        select={select}
        signIn={vi.fn()}
      />
    )
    const button = screen.getByRole('button', { name: 'Make default' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Sign in to this account before making it the default')
    fireEvent.click(button)
    expect(select).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)(
    'guides signed-out %s System accounts to terminal sign-in',
    (provider) => {
      renderDom(
        <AccountCapacityRow
          row={row({ provider, isSystem: true, accountId: null, state: 'signed-out' })}
          model={accountModel({ accountRuntimeSentenceLabel: 'remote build host' })}
          select={vi.fn()}
          signIn={vi.fn()}
        />
      )
      expect(
        screen.getByText(
          `Run "${provider} login" in a terminal on remote build host to restore the System login.`
        )
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
      expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull()
    }
  )

  it.each([
    ['expired', 'The saved sign-in expired'],
    ['revoked', 'The sign-in was revoked'],
    ['no-login', 'No sign-in found on this computer']
  ] as const)('explains the %s sign-out reason', (signedOutReason, reason) => {
    expect(render(row({ state: 'signed-out', signedOutReason }))).toContain(
      `Sign-in status: ${reason}`
    )
  })

  it('includes the weekday for a paused reading at least a day old', () => {
    const oldReading = Date.now() - 2 * 24 * 60 * 60 * 1000
    const time = new Date(oldReading).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
    expect(
      render(row({ state: 'usable', readingAt: oldReading, readingPausedUntil: reset }))
    ).toContain(`Updated ${time}`)
  })

  it('uses the Codex System identity before the runtime label', () => {
    const model = accountModel({
      systemCodexIdentity: {
        email: 'codex-system@example.com',
        hasAuth: true,
        authKind: 'oauth',
        providerAccountId: null,
        workspaceLabel: null
      }
    })
    expect(
      render(row({ provider: 'codex', isSystem: true, accountId: null, email: null }), model)
    ).toContain('codex-system@example.com')
    expect(
      render(row({ provider: 'claude', isSystem: true, accountId: null, email: null }), model)
    ).toContain('Local computer')
    expect(
      render(row({ provider: 'codex', isSystem: true, accountId: null, email: null }))
    ).toContain('Local computer')
    expect(render(row({ email: null }), model)).toContain('Unknown email')
  })

  it('marks a managed default with a badge', () => {
    const html = render(row({ isDefault: true }))
    expect(html).toContain('data-slot="badge"')
    expect(html).toContain('>Default<')
    expect(html).not.toContain('Make default')
  })
})

it.each([0, 1, 3])(
  'shows %s redeemable resets in Settings and the compact limited picker',
  (count) => {
    const capacity = row({
      provider: 'codex',
      availableResetCredits: count,
      state: 'limited',
      limitedUntil: reset
    })
    expect(render(capacity)).toContain(`Usage resets: ${count} available`)
    expect(formatCapacityCompact(capacity)).toContain(`Usage resets: ${count} available`)
    expect(formatCapacityCompact(capacity)).toContain('Rate limited until')
  }
)
it('does not claim zero resets for older hosts or Claude', () => {
  expect(render(row({ provider: 'codex' }))).toContain('Usage resets: not reported')
  expect(render(row())).toContain('Usage resets: not reported')
})
