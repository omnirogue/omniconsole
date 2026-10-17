import { expect, it } from 'vitest'
import { UiUpdate } from './client-ui-schemas'
import { EMPTY_SIDEBAR_LAYOUT, withSavedView } from '../../../../shared/sidebar-layout'
import {
  SIDEBAR_GROUPS_CAPABILITY,
  supportsSidebarGroups,
  withSidebarGroup
} from '../../../../shared/sidebar-custom-groups'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'

it('preserves group definitions in live and saved layouts across the host schema', () => {
  const sidebarLayout = withSavedView(
    withSidebarGroup(EMPTY_SIDEBAR_LAYOUT, 'custom-focus', 'Focus'),
    'day',
    'Day'
  )
  expect(UiUpdate.parse({ sidebarWidth: 300, sidebarLayout })).toEqual({
    sidebarWidth: 300,
    sidebarLayout
  })
  expect(UiUpdate.parse({ sidebarLayout: EMPTY_SIDEBAR_LAYOUT })).toEqual({
    sidebarLayout: EMPTY_SIDEBAR_LAYOUT
  })
})

it('offers custom group creation only to capable paired hosts while retaining native support', () => {
  expect(supportsSidebarGroups(false)).toBe(true)
  expect(supportsSidebarGroups(true)).toBe(false)
  expect(supportsSidebarGroups(true, [])).toBe(false)
  expect(supportsSidebarGroups(true, [SIDEBAR_GROUPS_CAPABILITY])).toBe(true)
  expect(RUNTIME_CAPABILITIES).toContain(SIDEBAR_GROUPS_CAPABILITY)
})

for (const activeView of ['attention', 'grid']) {
  it(`retains ${activeView} in the client UI RPC enum`, () => {
    expect(UiUpdate.parse({ activeView })).toEqual({ activeView })
  })
}
