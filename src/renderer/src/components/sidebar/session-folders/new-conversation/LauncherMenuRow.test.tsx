/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { LauncherMenuRow } from './LauncherMenuRow'

afterEach(cleanup)
const hover = {
  onPointerMove: vi.fn(),
  onInteractOutside: vi.fn(),
  onOpenAutoFocus: vi.fn(),
  onCloseAutoFocus: vi.fn(),
  onPointerEnter: vi.fn(),
  onPointerLeave: vi.fn(),
  onPointerDownCapture: vi.fn()
}

it('starring a leaf neither launches nor closes the menu', () => {
  const launch = vi.fn()
  const makeDefault = vi.fn()
  const openChange = vi.fn()
  render(
    <DropdownMenu open onOpenChange={openChange}>
      <DropdownMenuContent>
        <LauncherMenuRow hover={hover} onLaunch={launch} onDefault={makeDefault}>
          Grok
        </LauncherMenuRow>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const star = screen.getByRole('button', { name: 'Make default' })
  fireEvent.pointerDown(star, { button: 0 })
  fireEvent.pointerUp(star, { button: 0 })
  fireEvent.click(star)
  expect(makeDefault).toHaveBeenCalledOnce()
  expect(launch).not.toHaveBeenCalled()
  expect(openChange).not.toHaveBeenCalled()
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem'))
  expect(launch).toHaveBeenCalledOnce()
})

it('D makes a focused row default without launching', () => {
  const launch = vi.fn()
  const makeDefault = vi.fn()
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <LauncherMenuRow hover={hover} onLaunch={launch} onDefault={makeDefault}>
          Grok
        </LauncherMenuRow>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'd' })
  expect(makeDefault).toHaveBeenCalledOnce()
  expect(launch).not.toHaveBeenCalled()
})
