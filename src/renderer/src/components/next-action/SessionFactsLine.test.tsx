// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFactsLine, frontTruncate } from './SessionFactsLine'
import type { SessionDetailsFacts } from './session-details-facts'

afterEach(cleanup)

const facts = {
  agent: { name: 'Codex', state: 'idle', detail: null },
  runsOn: 'This device',
  workspace: '/Users/maintainer/Work/OmniAgentOS/Prototypes/omni-ide · refs/heads/main-next',
  savesTo: 'none',
  task: null
} as unknown as SessionDetailsFacts

it('folds a long path from the front so the branch and last segment survive', () => {
  expect(frontTruncate('sal/omni-brand · refs/heads/main-next')).toBe(
    'sal/omni-brand · refs/heads/main-next'
  )
  expect(frontTruncate('/Users/maintainer/Work/OmniAgentOS/Prototypes/omni-ide')).toBe(
    '…/Work/OmniAgentOS/Prototypes/omni-ide'
  )
  // No segment boundary near the cut: a plain tail, still never the head.
  expect(frontTruncate('a'.repeat(60))).toBe(`…${'a'.repeat(39)}`)
})

it('renders one muted line with the full values in title, and a Details disclosure', () => {
  const onToggle = vi.fn()
  render(<SessionFactsLine facts={facts} open={false} controls="card" onToggle={onToggle} />)
  const line = document.querySelector('[data-next-action-facts-line]')!
  expect(line.textContent).toBe(
    'Codex · This device · …/omni-ide · refs/heads/main-next · Task: noneDetails▸'
  )
  expect(line.querySelector('span')!.getAttribute('title')).toBe(
    'Codex · This device · /Users/maintainer/Work/OmniAgentOS/Prototypes/omni-ide · refs/heads/main-next · Task: none'
  )
  const toggle = screen.getByRole('button', { name: /^Details/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.getAttribute('aria-controls')).toBe('card')
  fireEvent.click(toggle)
  expect(onToggle).toHaveBeenCalledOnce()
})

it('names the attached task and shows the open glyph while expanded', () => {
  render(
    <SessionFactsLine
      facts={{ ...facts, task: { id: 't1', title: 'Ship the fold' } }}
      open
      controls="card"
      onToggle={() => {}}
    />
  )
  expect(document.querySelector('[data-next-action-facts-line]')!.textContent).toContain(
    'Task: Ship the fold'
  )
  expect(screen.getByRole('button', { name: /^Details/ }).getAttribute('aria-expanded')).toBe(
    'true'
  )
})
