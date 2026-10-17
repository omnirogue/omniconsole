// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  useHoverOpenPopover
} from './use-hover-open-popover'

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({
    open,
    onOpenChange: (next) => {
      onOpenChange?.(next)
      setOpen(next)
    }
  })
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <button type="button" aria-expanded={open} {...hover.anchorProps}>
          Anchor
        </button>
      </PopoverAnchor>
      <PopoverContent {...hover.contentProps}>
        <button type="button">Inside</button>
      </PopoverContent>
    </Popover>
  )
}

const anchor = (): HTMLElement => screen.getByRole('button', { name: 'Anchor' })
const isOpen = (): boolean => anchor().getAttribute('aria-expanded') === 'true'
let hoverCapable = true

beforeEach(() => {
  vi.useFakeTimers()
  hoverCapable = true
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query === '(hover: hover)' && hoverCapable })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useHoverOpenPopover', () => {
  it('opens after the hover delay and closes after the leave delay', () => {
    render(<Harness />)
    fireEvent.pointerEnter(anchor())
    expect(isOpen()).toBe(false)
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
    expect(isOpen()).toBe(true)
    fireEvent.pointerLeave(anchor())
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 1))
    expect(isOpen()).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(isOpen()).toBe(false)
  })

  it('keeps the popover open while the pointer is inside the content', () => {
    render(<Harness />)
    fireEvent.pointerEnter(anchor())
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
    fireEvent.pointerLeave(anchor())
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Inside' }).parentElement!)
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
    expect(isOpen()).toBe(true)
  })

  it('pins on click so leaving no longer closes it, and a second click closes it', () => {
    render(<Harness />)
    fireEvent.click(anchor())
    expect(isOpen()).toBe(true)
    fireEvent.pointerLeave(anchor())
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
    expect(isOpen()).toBe(true)
    fireEvent.click(anchor())
    expect(isOpen()).toBe(false)
  })

  // Measured on 1.12.0: every mouse click landed after the 120 ms hover-open and closed the
  // popover again, so ＋, Add agent and Team looked like they did nothing.
  it('keeps a hover-opened popover open on the click that follows, and pins it', () => {
    render(<Harness />)
    fireEvent.pointerEnter(anchor())
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
    expect(isOpen()).toBe(true)
    fireEvent.click(anchor())
    expect(isOpen()).toBe(true)
    fireEvent.pointerLeave(anchor())
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
    expect(isOpen()).toBe(true)
    fireEvent.click(anchor())
    expect(isOpen()).toBe(false)
  })

  // Measured on 1.12.2 with a live event log: mouse-down focused the anchor (Radix focusOutside),
  // then the pointer-down-outside Radix defers past the click fired — both dismissed the popover.
  it('does not let a press on its own anchor count as an outside interaction', () => {
    render(<Harness />)
    fireEvent.pointerEnter(anchor())
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
    // Radix registers its outside listeners a tick after the content mounts.
    act(() => vi.advanceTimersByTime(1))
    expect(isOpen()).toBe(true)
    fireEvent.pointerDown(anchor())
    fireEvent.focusIn(anchor())
    fireEvent.click(anchor())
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
    expect(isOpen()).toBe(true)
    // A real outside press still closes it (Radix defers a left-button press to its click).
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(isOpen()).toBe(false)
  })

  it('pins from the keyboard with Enter, Space or ArrowDown', () => {
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      render(<Harness />)
      fireEvent.keyDown(anchor(), { key })
      expect(isOpen()).toBe(true)
      fireEvent.pointerLeave(anchor())
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
      expect(isOpen()).toBe(true)
      cleanup()
    }
  })

  it('never opens from hover on a device without hover', () => {
    hoverCapable = false
    render(<Harness />)
    fireEvent.pointerEnter(anchor())
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS * 2))
    expect(isOpen()).toBe(false)
    fireEvent.click(anchor())
    expect(isOpen()).toBe(true)
  })

  it('forgets the pin once the popover closes for any reason', () => {
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    fireEvent.click(anchor())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inside' }), { key: 'Escape' })
    expect(isOpen()).toBe(false)
    fireEvent.pointerEnter(anchor())
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS))
    expect(isOpen()).toBe(true)
    fireEvent.pointerLeave(anchor())
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS))
    expect(isOpen()).toBe(false)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })
})

it('clears a cascade leave timer on movement within its parent content', () => {
  const onOpenChange = vi.fn()
  const { result } = renderHook(() => useHoverOpenPopover({ open: true, onOpenChange }))
  act(() => {
    result.current.contentProps.onPointerLeave()
    result.current.contentProps.onPointerMove()
    vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS + 1)
  })
  expect(onOpenChange).not.toHaveBeenCalled()
})

it('preserves keyboard focus intent until delayed close autofocus, then clears it', () => {
  const { result } = renderHook(() => useHoverOpenPopover({ open: true, onOpenChange: vi.fn() }))
  act(() => {
    result.current.anchorProps.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() } as never)
    result.current.onOpenChange(false)
  })
  const keyboardClose = new Event('close', { cancelable: true })
  result.current.contentProps.onCloseAutoFocus(keyboardClose)
  expect(keyboardClose.defaultPrevented).toBe(false)
  const pointerClose = new Event('close', { cancelable: true })
  result.current.contentProps.onCloseAutoFocus(pointerClose)
  expect(pointerClose.defaultPrevented).toBe(true)
})
