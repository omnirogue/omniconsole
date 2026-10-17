import { describe, expect, it } from 'vitest'
import {
  decodeSidebarLayout,
  EMPTY_SIDEBAR_LAYOUT,
  withSavedView,
  withAppliedView,
  withHidden
} from './sidebar-layout'
import { sidebarMemberScope, withSidebarMemberPlacement } from './sidebar-navigation-placement'

describe('sidebar destinations', () => {
  it('moves between groups without duplicate rows and survives a saved-view round trip', () => {
    let layout = withSidebarMemberPlacement(
      EMPTY_SIDEBAR_LAYOUT,
      'agents:skills',
      'nav:work',
      ['work:tasks'],
      'work:tasks',
      'before'
    )
    expect(layout.orders['nav:work']).toEqual(['agents:skills', 'work:tasks'])
    expect(sidebarMemberScope(layout, 'agents:skills', 'nav:agents')).toBe('nav:work')
    layout = withSavedView(layout, 'focus', 'Focus')
    layout = withSidebarMemberPlacement(layout, 'agents:skills', 'nav:agents', ['agents:machines'])
    expect(layout.orders['nav:work']).not.toContain('agents:skills')
    expect(layout.orders['nav:agents'].filter((id) => id === 'agents:skills')).toHaveLength(1)
    layout = withAppliedView(decodeSidebarLayout(JSON.parse(JSON.stringify(layout))), 'focus')
    expect(sidebarMemberScope(layout, 'agents:skills', 'nav:agents')).toBe('nav:work')
  })
  it('adds settings after existing rows, reveals the group, and restores a removed pin', () => {
    const hidden = withHidden(
      withHidden(EMPTY_SIDEBAR_LAYOUT, 'settings:appearance', 'Appearance'),
      'nav:agents',
      'Agents'
    )
    const layout = withSidebarMemberPlacement(hidden, 'settings:appearance', 'nav:agents', [])
    expect(layout.orders['nav:agents'].at(-1)).toBe('settings:appearance')
    expect(layout.hidden).toEqual({})
    expect(sidebarMemberScope(layout, 'settings:appearance', null)).toBe('nav:agents')
  })
  it('refuses non-navigation drags and invalid destination scopes', () => {
    expect(withSidebarMemberPlacement(EMPTY_SIDEBAR_LAYOUT, 'company:secret', 'nav:work', [])).toBe(
      EMPTY_SIDEBAR_LAYOUT
    )
    expect(withSidebarMemberPlacement(EMPTY_SIDEBAR_LAYOUT, 'agents:skills', '__proto__', [])).toBe(
      EMPTY_SIDEBAR_LAYOUT
    )
  })
})
