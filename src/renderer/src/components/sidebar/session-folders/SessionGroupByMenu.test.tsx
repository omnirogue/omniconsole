// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionFocusDrill } from './use-session-focus-view'

// Why: the menu's portal needs real layout; stand-ins keep this on the picker's choices.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<(value: string) => void>(() => {})
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuRadioGroup: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children?: ReactNode
    }) => (
      <SelectContext.Provider value={onValueChange}>
        <div data-selected={value}>{children}</div>
      </SelectContext.Provider>
    ),
    DropdownMenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const onSelect = React.useContext(SelectContext)
      return (
        <button type="button" role="menuitemradio" onClick={() => onSelect(value)}>
          {children}
        </button>
      )
    }
  }
})

import { SessionGroupByMenu } from './SessionGroupByMenu'

const selected = () => document.querySelector('[data-selected]')?.getAttribute('data-selected')

beforeEach(() => {
  localStorage.clear()
  useSessionSidebarView.setState({ view: emptySessionSidebarView(), loaded: true })
  useSessionFocusDrill.setState({ drilled: false })
})

afterEach(cleanup)

describe('SessionGroupByMenu (the View picker)', () => {
  it('defaults to Sessions and keeps Folders, Focus and the Group-by views available', () => {
    render(<SessionGroupByMenu />)
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Sessions',
      'Folders',
      'Focus',
      'Status',
      'Computer',
      'Project',
      'Company',
      'Request',
      "What's blocking"
    ])
    expect(selected()).toBe('flat')
    expect(screen.getByRole('button', { name: 'View: Sessions' })).toBeTruthy()
  })

  it('picks the Status view under its own id, never the folder tree grouping', () => {
    render(<SessionGroupByMenu />)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Status' }))
    expect(useSessionSidebarView.getState().view).toMatchObject({ lens: 'state', layout: 'full' })
    expect(screen.getByRole('button', { name: 'View: Status' })).toBeTruthy()
  })

  it('saves one choice per device and ends a drill-in from a Focus line', () => {
    render(<SessionGroupByMenu />)
    useSessionFocusDrill.setState({ drilled: true })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Computer' }))
    expect(useSessionFocusDrill.getState().drilled).toBe(false)
    expect(useSessionSidebarView.getState().view).toMatchObject({
      lens: 'computer',
      layout: 'full'
    })
    expect(selected()).toBe('computer')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Folders' }))
    expect(useSessionSidebarView.getState().view.lens).toBeUndefined()
    expect(useSessionSidebarView.getState().view.layout).toBe('full')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Focus' }))
    expect(useSessionSidebarView.getState().view.layout).toBe('focus')
    expect(selected()).toBe('focus')
  })
})
