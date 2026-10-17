// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatAgentExitedNotice } from './NativeChatAgentExitedNotice'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
      : fallback
}))
afterEach(cleanup)

it('offers resume first when a session was recorded and carries the unsent draft', () => {
  const onResume = vi.fn()
  const onRestart = vi.fn()
  render(
    <NativeChatAgentExitedNotice
      agent="codex"
      canResume
      hasUndeliveredPrompt
      onResume={onResume}
      onRestart={onRestart}
    />
  )
  expect(screen.getByText("Codex exited — this conversation's history is kept.")).toBeTruthy()
  expect(screen.getByText(/carried over as a draft/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
  expect(onResume).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Start Codex again' }))
  expect(onRestart).toHaveBeenCalledOnce()
})

it('only offers a fresh start when nothing resumable exists', () => {
  render(
    <NativeChatAgentExitedNotice
      agent="claude"
      canResume={false}
      hasUndeliveredPrompt={false}
      onRestart={vi.fn()}
      onOpenTerminal={vi.fn()}
    />
  )
  expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Start Claude Code again' })).toBeTruthy()
  expect(screen.getByText(/stopped before it reported a session/)).toBeTruthy()
})
