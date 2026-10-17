// @vitest-environment happy-dom
/**
 * Brief 78 #2: idle with nothing composed, Up next is the Now row (lighter, no glyph) and the
 * dashed slot — no ghost end-cap row, no "Nothing queued." footer, no disabled "Up to date".
 * Busy-and-empty keeps amendment 1's shape, and a draft brings the end cap and the footer back.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { upNextFixture } from './up-next-fixture'
import { idleEmpty } from './up-next-chain-rules'
import type { UpNextController } from './use-up-next'
import type { UpNextView } from '../../../../shared/up-next-types'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

afterEach(cleanup)

function controller(view: UpNextView): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view,
    error: null,
    disabled: false,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

function idleEmptyView(): UpNextView {
  const view = upNextFixture('busy')
  return {
    ...view,
    header: { state: 'idle' },
    now: { kind: 'idle', agent: 'Claude Code' }
  }
}

it('shows only the Now row and the dashed slot while idle with nothing composed', () => {
  const view = idleEmptyView()
  expect(idleEmpty(view)).toBe(true)
  render(<UpNextChainView controller={controller(view)} />)
  const now = document.querySelector('[data-up-next-now]')!
  expect(now.hasAttribute('data-up-next-now-quiet')).toBe(true)
  expect(now.textContent).not.toContain('◦')
  expect(now.className).not.toContain('border-l-[3px]')
  expect(screen.getByText('+ next block goes here')).toBeTruthy()
  expect(screen.queryByText('…then waits for you · tab stays open')).toBeNull()
  expect(document.querySelector('footer')).toBeNull()
  expect(screen.queryByText('Nothing queued.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Up to date' })).toBeNull()
  // The add bar is still the way in.
  expect(screen.getByRole('button', { name: '+ Agent Review' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '+ Agent Handoff' })).toBeTruthy()
})

it('keeps the busy three-row shape and the disabled Up to date while the agent works', () => {
  const view = upNextFixture('busy')
  expect(idleEmpty(view)).toBe(false)
  render(<UpNextChainView controller={controller(view)} />)
  const now = document.querySelector('[data-up-next-now]')!
  expect(now.hasAttribute('data-up-next-now-quiet')).toBe(false)
  expect(now.textContent).toContain('▶')
  expect(screen.getByText('…then waits for you · tab stays open')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Up to date' }).hasAttribute('disabled')).toBe(true)
})

it('keeps a legacy Done choice outside the idle work track', () => {
  const draft = upNextFixture('done').blocks.find((block) => block.kind === 'done')!
  const view = { ...idleEmptyView(), blocks: [draft], draftCount: 1 }
  render(<UpNextChainView controller={controller(view)} />)
  expect(document.querySelector('footer')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Finish now' })).toBeNull()
  expect(document.querySelector('[data-up-next-stop]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Close session' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})
