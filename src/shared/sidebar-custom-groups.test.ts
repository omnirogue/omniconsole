import { describe, expect, it } from 'vitest'
import { decodeSidebarGroups, withSidebarGroup, withoutSidebarGroup } from './sidebar-custom-groups'
import {
  EMPTY_SIDEBAR_LAYOUT,
  activeViewIsDirty,
  decodeSidebarLayout,
  isDefaultLayout,
  withAppliedView,
  withSavedView
} from './sidebar-layout'
import { sidebarMemberScope, withSidebarMemberPlacement } from './sidebar-navigation-placement'

describe('custom sidebar groups', () => {
  it('persists custom placement and group names through decoding and saved arrangements', () => {
    let layout = withSidebarGroup(EMPTY_SIDEBAR_LAYOUT, 'custom-focus', ' Focus ')
    expect(isDefaultLayout(layout)).toBe(false)
    layout = withSidebarMemberPlacement(layout, 'agents:skills', 'nav:custom-focus', [])
    layout = withSidebarMemberPlacement(layout, 'settings:appearance', 'nav:custom-focus', [
      'agents:skills'
    ])
    layout = withSavedView(layout, 'day', 'My day')
    layout = withSidebarMemberPlacement(layout, 'agents:skills', 'nav:work', [])
    expect(activeViewIsDirty(layout)).toBe(true)
    layout = withAppliedView(decodeSidebarLayout(JSON.parse(JSON.stringify(layout))), 'day')
    expect(layout.groups).toEqual([{ id: 'custom-focus', name: 'Focus' }])
    expect(sidebarMemberScope(layout, 'agents:skills', 'nav:agents')).toBe('nav:custom-focus')
    expect(layout.orders['nav:custom-focus']).toEqual(['agents:skills', 'settings:appearance'])
    expect(activeViewIsDirty(layout)).toBe(false)
  })

  it('returns members to defaults and preserves settings pins when a group is deleted', () => {
    let layout = withSidebarGroup(EMPTY_SIDEBAR_LAYOUT, 'custom-focus', 'Focus')
    for (const id of ['agents:skills', 'work:tasks', 'settings:appearance']) {
      layout = withSidebarMemberPlacement(
        layout,
        id,
        'nav:custom-focus',
        layout.orders['nav:custom-focus'] ?? []
      )
    }
    layout = withoutSidebarGroup(layout, 'custom-focus')
    expect(layout.groups).toBeUndefined()
    expect(layout.orders['nav:custom-focus']).toBeUndefined()
    expect(sidebarMemberScope(layout, 'agents:skills', 'nav:agents')).toBe('nav:agents')
    expect(sidebarMemberScope(layout, 'work:tasks', 'nav:work')).toBe('nav:work')
    expect(sidebarMemberScope(layout, 'settings:appearance', null)).toBe('nav:agents')
  })

  it('applies an old saved arrangement without keeping custom groups from the current one', () => {
    const saved = withSavedView(EMPTY_SIDEBAR_LAYOUT, 'default', 'Default')
    const grouped = withSidebarGroup(saved, 'custom-focus', 'Focus')
    expect(activeViewIsDirty(grouped)).toBe(true)
    expect(withAppliedView(grouped, 'default')).toEqual(saved)
  })

  it('ignores malformed, duplicate, blank and excessive groups without changing old layouts', () => {
    expect(decodeSidebarLayout({})).toEqual(EMPTY_SIDEBAR_LAYOUT)
    expect(
      decodeSidebarGroups([
        null,
        {},
        { id: '__proto__', name: 'Bad' },
        { id: 'custom-blank', name: ' ' },
        { id: 'custom-one', name: 'One' },
        { id: 'custom-one', name: 'Other' },
        { id: 'custom-two', name: ' ONE ' }
      ])
    ).toEqual([{ id: 'custom-one', name: 'One' }])
    expect(
      decodeSidebarGroups(
        Array.from({ length: 30 }, (_, index) => ({ id: `custom-${index}`, name: `${index}` }))
      )
    ).toHaveLength(24)
    expect(
      withSidebarMemberPlacement(EMPTY_SIDEBAR_LAYOUT, 'agents:skills', 'nav:custom-missing', [])
    ).toBe(EMPTY_SIDEBAR_LAYOUT)
  })
})
