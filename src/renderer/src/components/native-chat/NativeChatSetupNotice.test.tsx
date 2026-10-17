// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatSetupNotice, hasOptionalAutomationReview } from './NativeChatSetupNotice'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
      : fallback
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const UPDATE_MENU =
  '› Ask Codex to do anything\n✨ Update available!\n0.153.0 -> 0.154.0\n› 1. Update now (runs `npm install -g @openai/codex`)\n2. Skip\n3. Skip until next version\nPress enter to continue'
const HOOK_TRUST_MENU =
  "Hooks need review\n6 hooks are new or changed.\nHooks can run outside the sandbox after you trust them.\n› 1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)\nPress enter to confirm or esc to go back"

it('requires the actual hook review screen, not a mention in work', () => {
  expect(hasOptionalAutomationReview('Discuss Hooks and review')).toBe(false)
  expect(
    hasOptionalAutomationReview(
      'Hooks\n1 hook needs review before it can run.\nPress t to trust all; enter to review hooks; esc to close'
    )
  ).toBe(true)
})

it('keeps setup actionable without approving automation and clears when the pane moves on', () => {
  vi.useFakeTimers()
  let text = 'Hooks\n1 hook needs review\nesc to close'
  const skip = vi.fn(),
    blocked = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="codex"
      readScreen={() => text}
      canSend
      onContinue={skip}
      onBlockedChange={blocked}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue without it' }))
  expect(skip).toHaveBeenCalledOnce()
  expect(blocked).toHaveBeenLastCalledWith(true)
  text = 'Ask Codex to do anything'
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(screen.queryByRole('status')).toBeNull()
  expect(blocked).toHaveBeenLastCalledWith(false)
})

it('holds the composer on the Codex update menu and sends only the chosen answer', () => {
  vi.useFakeTimers()
  const sendRaw = vi.fn()
  const blocked = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="codex"
      readScreen={() => UPDATE_MENU}
      canSend
      sendRaw={sendRaw}
      onContinue={vi.fn()}
      onBlockedChange={blocked}
    />
  )
  expect(screen.getByRole('status').getAttribute('data-native-chat-startup-intervention')).toBe(
    'update-available'
  )
  expect(screen.getByText('Codex is offering an update (0.153.0 → 0.154.0)')).toBeTruthy()
  expect(blocked).toHaveBeenLastCalledWith(true)
  const skip = screen.getByRole('button', { name: 'Skip this time' })
  fireEvent.click(skip)
  fireEvent.click(skip)
  expect(sendRaw).toHaveBeenCalledTimes(1)
  expect(sendRaw).toHaveBeenCalledWith('2\r')
  act(() => {
    vi.advanceTimersByTime(1600)
  })
  fireEvent.click(screen.getByRole('button', { name: /Update now/ }))
  expect(sendRaw).toHaveBeenLastCalledWith('1\r')
})

it('refreshes the decline action when a closeable hook drawer becomes the startup trust menu', () => {
  vi.useFakeTimers()
  let text = 'Hooks\n1 hook needs review\nesc to close'
  const sendRaw = vi.fn()
  const onReview = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="codex"
      readScreen={() => text}
      canSend
      sendRaw={sendRaw}
      onContinue={vi.fn()}
      onReview={onReview}
      onBlockedChange={vi.fn()}
    />
  )
  text = HOOK_TRUST_MENU
  act(() => vi.advanceTimersByTime(1000))
  expect(sendRaw).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue without it' }))
  expect(sendRaw).toHaveBeenCalledExactlyOnceWith('3\r')
  fireEvent.click(screen.getByRole('button', { name: 'Open Terminal…' }))
  expect(onReview).toHaveBeenCalledOnce()
  expect(sendRaw).toHaveBeenCalledOnce()
})

it('does not use the legacy Escape callback for a numbered hook-trust choice', () => {
  const onContinue = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="codex"
      readScreen={() => HOOK_TRUST_MENU}
      canSend
      onContinue={onContinue}
      onReview={vi.fn()}
      onBlockedChange={vi.fn()}
    />
  )
  const decline = screen.getByRole('button', { name: 'Continue without it' })
  expect((decline as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(decline)
  expect(onContinue).not.toHaveBeenCalled()
})

it('explains a diverging update target for the Codex updater', async () => {
  const readInstallation = vi.fn().mockResolvedValue({
    command: '/Users/maintainer/.local/bin/codex',
    realPath: '/Users/maintainer/.local/node/bin/codex',
    version: '0.153.0',
    npmGlobalPrefix: '/Users/maintainer/.local/opt/node',
    npmGlobalCodexPath: '/Users/maintainer/.local/opt/node/bin/codex',
    npmGlobalCodexVersion: '0.154.0',
    updateTargetDiverges: true,
    checkedAt: 1
  })
  render(
    <NativeChatSetupNotice
      enabled
      agent="codex"
      readScreen={() => UPDATE_MENU}
      canSend
      sendRaw={vi.fn()}
      onContinue={vi.fn()}
      onBlockedChange={vi.fn()}
      readInstallation={readInstallation}
    />
  )
  expect(
    await screen.findByText(
      /Its updater installs into \/Users\/sal\/\.local\/opt\/node \(0\.154\.0 is already there\)/
    )
  ).toBeTruthy()
})

it('offers the Claude folder-trust choices and routes sign-in to the terminal', () => {
  const sendRaw = vi.fn()
  const onReview = vi.fn()
  const { rerender } = render(
    <NativeChatSetupNotice
      enabled
      agent="claude"
      readScreen={() =>
        'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder'
      }
      canSend
      sendRaw={sendRaw}
      onContinue={vi.fn()}
      onReview={onReview}
      onBlockedChange={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Trust and continue' }))
  expect(sendRaw).toHaveBeenCalledWith('\x1b[B\r')
  rerender(
    <NativeChatSetupNotice
      enabled
      agent="claude"
      readScreen={() => 'Select login method\n1. Claude account with subscription'}
      canSend
      sendRaw={sendRaw}
      onContinue={vi.fn()}
      onReview={onReview}
      onBlockedChange={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open Terminal…' }))
  expect(onReview).toHaveBeenCalledOnce()
})

it('stays quiet for agents without startup screens', () => {
  const blocked = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="grok"
      readScreen={() => UPDATE_MENU}
      canSend
      onContinue={vi.fn()}
      onBlockedChange={blocked}
    />
  )
  expect(screen.queryByRole('status')).toBeNull()
  expect(blocked).toHaveBeenLastCalledWith(false)
})

it('holds Claude permission-mode setup until the person chooses to keep current permissions', () => {
  const blocked = vi.fn()
  const sendRaw = vi.fn()
  render(
    <NativeChatSetupNotice
      enabled
      agent="claude"
      readScreen={() =>
        'Make auto mode your default permission mode?\n❯ Yes, set auto mode as my default permission mode\n  No, keep bypass permissions'
      }
      canSend
      sendRaw={sendRaw}
      onContinue={vi.fn()}
      onBlockedChange={blocked}
    />
  )
  expect(blocked).toHaveBeenLastCalledWith(true)
  expect(sendRaw).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Keep current permission mode' }))
  expect(sendRaw).toHaveBeenCalledOnce()
  expect(sendRaw).toHaveBeenCalledWith('\x1b[B\r')
})
