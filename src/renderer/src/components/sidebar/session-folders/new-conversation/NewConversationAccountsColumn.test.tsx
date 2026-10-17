/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'
import { NewConversationAccountsColumn } from './NewConversationAccountsColumn'
import { launcherAccountLines } from './launcher-account-lines'

const select = vi.hoisted(() => vi.fn())
const signIn = vi.hoisted(() => vi.fn())
vi.mock('./select-launcher-account', () => ({ selectLauncherAccount: select }))
vi.mock('./launcher-target', () => ({ openLauncherAccounts: signIn }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const now = Date.now()
const row = (patch: Partial<AccountCapacityRow> = {}): AccountCapacityRow => ({
  provider: 'claude',
  accountId: 'one',
  choiceId: 'managed:one',
  email: 'one@example.test',
  detail: null,
  isDefault: false,
  isSystem: false,
  state: 'usable',
  signedOutReason: null,
  limitedUntil: null,
  readingAt: now - 600_000,
  readingPausedUntil: null,
  sourceLabel: null,
  launchEnv: { CLAUDE_CONFIG_DIR: '/owned/one' },
  fiveHour: { windowMinutes: 300, remainingPercent: 80, resetsAt: now + 3600_000 },
  weekly: { windowMinutes: 10080, remainingPercent: 60, resetsAt: now + 86400_000 },
  fableWeekly: { windowMinutes: 10080, remainingPercent: 40, resetsAt: now + 86400_000 },
  ...patch
})
const hover = {
  onPointerEnter: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerLeave: vi.fn(),
  onPointerDownCapture: vi.fn(),
  onInteractOutside: vi.fn(),
  onOpenAutoFocus: vi.fn(),
  onCloseAutoFocus: vi.fn()
}
function menu(account: AccountCapacityRow) {
  const start = vi.fn()
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <NewConversationAccountsColumn
          agent="claude"
          rows={[account]}
          models={[]}
          local
          start={start}
          hover={hover}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return start
}
it.each(['ready', 'usable', 'limited', 'checking', 'signed-out'] as const)(
  'retains all windows on %s rows',
  (state) => {
    menu(row({ state, limitedUntil: state === 'limited' ? now + 1000 : null }))
    expect(screen.getByText(/5-hour limit: 80% left · resets/)).toBeTruthy()
    expect(screen.getByText(/Weekly limit: 60% left · resets/)).toBeTruthy()
    expect(screen.getByText(/Fable weekly: 40% left · resets/)).toBeTruthy()
    expect(screen.queryByText(/usage not read yet/)).toBeNull()
    if (state === 'usable') {
      expect(screen.getByText(/last updated/)).toBeTruthy()
    }
  }
)
it('shows the same "last updated" text the launcher and Settings share for a usable row', () => {
  expect(launcherAccountLines(row({ state: 'usable' }), now)).toContainEqual(
    expect.stringMatching(/^Ready · last updated /)
  )
})
it('shows usage-not-read only without windows', () => {
  expect(
    launcherAccountLines(
      row({ fiveHour: null, weekly: null, fableWeekly: null, readingAt: null }),
      now
    )
  ).toEqual(['Usage resets: not reported', 'Ready · usage not read yet'])
})
it('shows the reading-paused line when no windows exist yet and a reading is paused', () => {
  expect(
    launcherAccountLines(
      row({
        fiveHour: null,
        weekly: null,
        fableWeekly: null,
        readingAt: null,
        readingPausedUntil: now + 2000
      }),
      now
    )
  ).toEqual(['Usage resets: not reported', expect.stringContaining('usage reading paused until')])
})
it('keeps limited state alongside the retained reading without a contradicting ready line', () => {
  const lines = launcherAccountLines(
    row({ state: 'limited', limitedUntil: now + 1000, readingPausedUntil: now + 2000 }),
    now
  )
  expect(lines.some((line) => line.startsWith('Rate limited until'))).toBe(true)
  expect(lines.some((line) => line.includes('usage reading paused until'))).toBe(false)
  expect(lines.some((line) => line.startsWith('Fable weekly:'))).toBe(true)
})
it('only shows the reading-paused line for a usable row', () => {
  const lines = launcherAccountLines(row({ state: 'usable', readingPausedUntil: now + 2000 }), now)
  expect(lines.some((line) => line.includes('usage reading paused until'))).toBe(true)
})
it('does not offer the star or D action for a signed-out account but still opens sign-in', () => {
  menu(row({ state: 'signed-out', launchEnv: null }))
  expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull()
  const account = screen.getByRole('menuitem', { name: /one@example.test/ })
  fireEvent.keyDown(account, { key: 'd' })
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(account)
  expect(signIn).toHaveBeenCalledTimes(1)
})
it('allows a checking default placeholder to launch without a false sign-in action', () => {
  const account = row({ state: 'checking', launchEnv: null, isDefault: true })
  const start = menu(account)
  fireEvent.click(screen.getByRole('menuitem', { name: /one@example.test/ }))
  expect(start).toHaveBeenCalledWith({ agent: 'claude', account })
  expect(signIn).not.toHaveBeenCalled()
})
it('disables a non-default checking row instead of guessing its launch env', () => {
  const account = row({ state: 'checking', launchEnv: null, isDefault: false })
  const start = menu(account)
  fireEvent.click(screen.getByRole('menuitem', { name: /one@example.test/ }))
  expect(start).not.toHaveBeenCalled()
  expect(signIn).not.toHaveBeenCalled()
})
it('labels the System login row the way Settings does', () => {
  menu(
    row({
      accountId: null,
      choiceId: 'system',
      isSystem: true,
      email: 'same@example.test',
      launchEnv: { CLAUDE_CONFIG_DIR: '/home/.claude' }
    })
  )
  expect(screen.getByText('System login')).toBeTruthy()
  expect(screen.getByText('same@example.test')).toBeTruthy()
})

it('shows redeemable reset counts beside usage in the model picker account column', () => {
  menu(row({ provider: 'codex', availableResetCredits: 3 }))
  expect(screen.getByText('Usage resets: 3 available')).toBeTruthy()
})

it('shows a compact active and total count for each local account', () => {
  menu(row())
  expect(screen.getByText('Active: 0 · Total: 0')).toBeTruthy()
})
