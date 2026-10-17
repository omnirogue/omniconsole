// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { defaultSessionTags } from '@/lib/session-tags'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  createLocalSessionSidebarViewStorage,
  SESSION_SIDEBAR_VIEW_STORAGE_KEY
} from '@/lib/session-sidebar-view-storage'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { createSessionSidebarViewStore, useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionAgentFilter } from '@/store/session-agent-filter'
import { useSessionTags } from '@/store/session-tags'
import { SessionFilterMenu } from './SessionFilterMenu'

afterEach(() => {
  cleanup()
  localStorage.clear()
  useSessionSidebarView.setState({ view: emptySessionSidebarView(), loaded: true })
  useSessionAgentFilter.setState({ filter: null })
  useSessionTags.setState({ data: defaultSessionTags(), loaded: true, error: null, scope: 'test' })
})

function renderMenu(): void {
  render(
    <TooltipProvider>
      <SessionFilterMenu />
    </TooltipProvider>
  )
}

describe('SessionFilterMenu', () => {
  it('opens one popover with Agents and Tags sections, one Filter button', () => {
    renderMenu()
    expect(screen.queryByRole('button', { name: /claude/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Filter conversations' }))
    expect(screen.getAllByText('Agents')).not.toHaveLength(0)
    expect(screen.getAllByText('Tags')).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument()
  })

  it('shows secondary styling and a count badge once an agent filter is active, with a working Clear filters', () => {
    useSessionAgentFilter.setState({ filter: 'codex' })
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Filter conversations' })
    expect(trigger).toHaveAttribute('aria-pressed', 'true')
    expect(trigger).toHaveTextContent('1')
    fireEvent.click(trigger)
    // Why getAllBy: the Tags section keeps its own (disabled, no tags selected) Clear filters
    // button — the enabled one is the combined header action.
    const clearButtons = screen.getAllByRole('button', { name: 'Clear filters' })
    fireEvent.click(clearButtons.find((button) => !button.hasAttribute('disabled'))!)
    expect(useSessionAgentFilter.getState().filter).toBeNull()
  })

  it('saves the chosen sort on this device without counting it as a filter', () => {
    useSessionSidebarView.setState({ view: emptySessionSidebarView(), loaded: true })
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Filter conversations' })
    fireEvent.click(trigger)
    const sort = screen.getByRole('radiogroup', { name: 'Sort' })
    expect(
      within(sort)
        .getAllByRole('radio')
        .map((item) => item.textContent)
    ).toEqual(['Status', 'Name', 'Host', 'Manual'])
    fireEvent.click(within(sort).getByRole('radio', { name: 'Name' }))
    expect(useSessionSidebarView.getState().view.sort).toBe('name')
    expect(trigger).toHaveAttribute('aria-pressed', 'false')
    const stored = localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY))
    expect(JSON.parse(stored!).sort).toBe('name')
    const reloaded = createSessionSidebarViewStore(createLocalSessionSidebarViewStorage())
    reloaded.getState().load()
    expect(reloaded.getState().view.sort).toBe('name')
  })
})
