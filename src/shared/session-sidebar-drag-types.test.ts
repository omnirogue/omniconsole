import { describe, expect, it } from 'vitest'
import {
  isSessionSidebarDrag,
  LAUNCH_INTENT_DRAG_TYPE,
  SESSION_ROW_DRAG_TYPE,
  SESSION_GROUP_DRAG_TYPE,
  SESSION_GRID_DRAG_TYPE,
  SIDEBAR_DRAG_MIME
} from './session-sidebar-drag-types'

describe('sidebar preload drag passthrough', () => {
  it.each([
    LAUNCH_INTENT_DRAG_TYPE,
    SESSION_ROW_DRAG_TYPE,
    SESSION_GROUP_DRAG_TYPE,
    SESSION_GRID_DRAG_TYPE,
    SIDEBAR_DRAG_MIME
  ])('accepts %s alongside browser types', (type) => {
    expect(isSessionSidebarDrag(['text/plain', type])).toBe(true)
  })

  it('keeps external file and text drops out of the sidebar passthrough', () => {
    expect(isSessionSidebarDrag(['Files', 'text/plain'])).toBe(false)
    expect(isSessionSidebarDrag([])).toBe(false)
  })
})
