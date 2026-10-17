import { describe, expect, it } from 'vitest'
import {
  emptySessionSidebarView,
  parseSessionSidebarView,
  setWorkHeaderCollapsed,
  workHeaderCollapsedChoice
} from './session-sidebar-view'

describe('work header fold in the sidebar view', () => {
  it('accepts a view without the record and one with it', () => {
    expect(parseSessionSidebarView(emptySessionSidebarView()).workHeaderCollapsed).toBeUndefined()
    const view = parseSessionSidebarView({
      ...emptySessionSidebarView(),
      workHeaderCollapsed: { a: true, b: false }
    })
    expect(view.workHeaderCollapsed).toEqual({ a: true, b: false })
  })

  it('reads undefined when nobody chose, and adds or overwrites one key at a time', () => {
    const view = emptySessionSidebarView()
    expect(workHeaderCollapsedChoice(view, 'a')).toBeUndefined()
    const folded = setWorkHeaderCollapsed(view, 'a', true)
    expect(workHeaderCollapsedChoice(folded, 'a')).toBe(true)
    expect(workHeaderCollapsedChoice(folded, 'b')).toBeUndefined()
    const both = setWorkHeaderCollapsed(folded, 'b', false)
    const reopened = setWorkHeaderCollapsed(both, 'a', false)
    expect(reopened.workHeaderCollapsed).toEqual({ a: false, b: false })
    expect(view.workHeaderCollapsed).toBeUndefined()
  })
})
