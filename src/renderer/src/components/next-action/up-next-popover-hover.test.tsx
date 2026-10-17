// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS
} from '@/components/next-step/use-hover-open-popover'
import { UpNextPopover } from './UpNextPopover'
import type { SidebarSession } from '@/lib/sidebar-sessions'

vi.mock('./UpNextSubject', () => ({
  UpNextSubject: () => <button type="button">Composer</button>
}))

const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Conversation',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

const plus = (): HTMLElement => screen.getByRole('button', { name: 'Up next' })
const composerOpen = (): boolean => screen.queryByRole('button', { name: 'Composer' }) !== null

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query === '(hover: hover)' })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Sal, 2026-09-18: the box must appear from a hover over ＋, without a click.
it('opens the composer on hover after the open delay', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.pointerEnter(plus())
  expect(composerOpen()).toBe(false)
  act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
  expect(composerOpen()).toBe(true)
})

it('closes the composer once the pointer has been away for the grace period', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.pointerEnter(plus())
  act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
  fireEvent.pointerLeave(plus())
  act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 1))
  expect(composerOpen()).toBe(true)
  act(() => vi.advanceTimersByTime(1))
  expect(composerOpen()).toBe(false)
})

// The pointer has to be able to travel from ＋ into the box without it vanishing on the way.
it('keeps the composer open while the pointer is inside it', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.pointerEnter(plus())
  act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
  fireEvent.pointerLeave(plus())
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'Composer' }).parentElement!)
  act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
  expect(composerOpen()).toBe(true)
})

it('still opens on a click, and a second click closes it', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.click(plus())
  expect(composerOpen()).toBe(true)
  fireEvent.pointerLeave(plus())
  act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
  expect(composerOpen()).toBe(true)
  fireEvent.click(plus())
  expect(composerOpen()).toBe(false)
})

it('opens from the keyboard and closes on Escape', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.keyDown(plus(), { key: 'Enter' })
  expect(composerOpen()).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(composerOpen()).toBe(false)
})

// Sal, 2026-09-18: beside the ＋, never on top of it.
it('renders the box to the right of the trigger', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.click(plus())
  const content = document.querySelector('[data-up-next-composer]')
  expect(content?.getAttribute('data-side')).toBe('right')
  expect(content?.getAttribute('data-align')).toBe('start')
})

// At 1280px a ＋ at x≈606 opened a 768px box to x≈1400, leaving each row's Move up off-screen.
it('keeps the box within the room Radix measured beside the trigger', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} />)
  fireEvent.click(plus())
  const content = document.querySelector<HTMLElement>('[data-up-next-composer]')
  expect(content?.style.maxWidth).toBe('var(--radix-popover-content-available-width)')
})

// A hover must never pull the caret out of the pane's terminal or chat input.
it('leaves the focused input alone when hover opens the box', () => {
  render(
    <>
      <input aria-label="Terminal input" />
      <UpNextPopover subject={{ kind: 'session', session }} />
    </>
  )
  const input = screen.getByRole('textbox', { name: 'Terminal input' })
  input.focus()
  fireEvent.pointerEnter(plus())
  act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
  act(() => vi.advanceTimersByTime(1))
  expect(composerOpen()).toBe(true)
  expect(document.activeElement).toBe(input)
})
