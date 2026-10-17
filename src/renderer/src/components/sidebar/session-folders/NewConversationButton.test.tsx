/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  useHoverOpenPopover,
  HOVER_OPEN_DELAY_MS
} from '@/components/next-step/use-hover-open-popover'
import { NewConversationTrigger } from './NewConversationTrigger'

function Harness({ launch }: { launch: () => void }) {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  return (
    <DropdownMenu open={open} onOpenChange={hover.onOpenChange} modal={false}>
      <NewConversationTrigger starting={false} onStart={launch} hover={hover.anchorProps} />
      <DropdownMenuContent {...hover.contentProps}>
        <DropdownMenuItem>Provider</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true }))
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('one-click launcher trigger', () => {
  it('pointer press does not open options and click launches once', () => {
    const launch = vi.fn()
    render(<Harness launch={launch} />)
    const button = screen.getByRole('button', { name: 'New conversation' })
    fireEvent.pointerDown(button, { button: 0 })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('hover opens options without launching', () => {
    const launch = vi.fn()
    render(<Harness launch={launch} />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'New conversation' }))
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(launch).not.toHaveBeenCalled()
  })
  it('Enter launches and either arrow opens options', () => {
    const launch = vi.fn()
    render(<Harness launch={launch} />)
    const button = screen.getByRole('button', { name: 'New conversation' })
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(button, { key: 'ArrowRight' })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(launch).toHaveBeenCalledTimes(1)
  })
})

it('returns focus to the launcher after a keyboard-opened menu closes', async () => {
  render(<Harness launch={vi.fn()} />)
  const button = screen.getByRole('button', { name: 'New conversation' })
  button.focus()
  fireEvent.keyDown(button, { key: 'ArrowRight' })
  screen.getByRole('menuitem', { name: 'Provider' }).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(document.activeElement).toBe(button)
})
