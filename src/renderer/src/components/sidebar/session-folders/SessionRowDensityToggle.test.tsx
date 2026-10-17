// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalSessionSidebarViewStorage } from '@/lib/session-sidebar-view-storage'
import { emptySessionSidebarView, sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { createSessionSidebarViewStore, useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionRowDensityToggle } from './SessionRowDensityToggle'

beforeEach(() => {
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
})

afterEach(cleanup)

it('is checked by default and flips the per-device density', () => {
  render(<SessionRowDensityToggle />)
  const box = screen.getByRole('checkbox', { name: 'Compact rows' })
  expect(box.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(box)
  expect(useSessionSidebarView.getState().view.density).toBe('comfortable')
  expect(box.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(box)
  expect(sessionSidebarDensity(useSessionSidebarView.getState().view)).toBe('compact')
})

it('persists the density in the saved view and reads a view saved before it as compact', () => {
  const memory = new Map<string, string>()
  const storage = createLocalSessionSidebarViewStorage(() => ({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value)
  }))
  const archived = { load: () => [], save: vi.fn() }
  const store = createSessionSidebarViewStore(storage, archived)
  store.getState().load()
  expect(sessionSidebarDensity(store.getState().view)).toBe('compact')
  store.getState().setDensity('comfortable')
  const again = createSessionSidebarViewStore(storage, archived)
  again.getState().load()
  expect(again.getState().view.density).toBe('comfortable')
  again.getState().setDensity('compact')
  expect([...memory.values()].some((value) => value.includes('"density":"compact"'))).toBe(true)
})
