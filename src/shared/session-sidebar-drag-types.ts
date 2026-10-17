/** Personal sidebar gestures must pass through Electron's native-file drop bridge. */
export const SESSION_ROW_DRAG_TYPE = 'application/x-omni-session-row'
export const SESSION_GROUP_DRAG_TYPE = 'application/x-omni-session-group'
/** A Grid pane, tray chip or browser tab being placed in the Grid. */
export const SESSION_GRID_DRAG_TYPE = 'application/x-omni-session-grid'
export const LAUNCH_INTENT_DRAG_TYPE = 'application/x-omni-launch-intent'
export function isSessionSidebarDrag(types: readonly string[]): boolean {
  return (
    types.includes(SIDEBAR_DRAG_MIME) ||
    types.includes(SESSION_ROW_DRAG_TYPE) ||
    types.includes(SESSION_GROUP_DRAG_TYPE) ||
    types.includes(SESSION_GRID_DRAG_TYPE) ||
    types.includes(LAUNCH_INTENT_DRAG_TYPE)
  )
}

export const SIDEBAR_DRAG_MIME = 'application/x-omni-sidebar-order'
