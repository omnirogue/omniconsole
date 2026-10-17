import { SESSION_GRID_DRAG_TYPE } from '../../../shared/session-sidebar-drag-types'
import { getSessionSidebarDrag, readSessionSidebarDragKind } from './session-sidebar-drag'
import type { SessionGridPaneContent } from './session-grid-panes'

/** What is being dragged into the Grid, besides conversations from the sidebar. */
export type SessionGridDragPayload =
  /** A pane already on the grid, being rearranged. */
  | { kind: 'pane'; paneId: string }
  /** A minimized pane, from the tray. */
  | { kind: 'tray'; paneId: string }
  /** Something not in the grid yet: an open browser tab, a conversation from the Add list. */
  | { kind: 'content'; content: SessionGridPaneContent }

// Why module state: dragover cannot read dataTransfer payloads (see session-sidebar-drag.ts).
let inFlight: SessionGridDragPayload | null = null

export function beginSessionGridDrag(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  payload: SessionGridDragPayload
): void {
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(SESSION_GRID_DRAG_TYPE, payload.kind)
  inFlight = payload
}

export function getSessionGridDrag(): SessionGridDragPayload | null {
  return inFlight
}

export function clearSessionGridDrag(): void {
  inFlight = null
}

/** Whether a drag with these types can land on the Grid: a grid item or a sidebar conversation. */
export function isSessionGridDropTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  const list = types ? Array.from(types) : []
  return list.includes(SESSION_GRID_DRAG_TYPE) || readSessionSidebarDragKind(list) === 'row'
}

/** The sidebar conversations in flight, by view key: the whole selection when a selected row moves. */
export function sidebarSessionKeysInFlight(): string[] {
  const drag = getSessionSidebarDrag()
  if (drag?.kind !== 'row') {
    return []
  }
  const keys = drag.batch?.sessionKeys.length ? drag.batch.sessionKeys : [drag.sessionKey]
  // Why: a routine row stands for its runs, not one conversation the grid could show.
  return [...new Set(keys)].filter((key) => !key.startsWith('routine:'))
}
