import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import type { SessionFolderSection } from './session-folder-tree'
import type { SessionSidebarGroupKind } from './session-sidebar-group-model'
import {
  SESSION_ROW_DRAG_TYPE,
  SESSION_GROUP_DRAG_TYPE
} from '../../../shared/session-sidebar-drag-types'
export { SESSION_ROW_DRAG_TYPE, SESSION_GROUP_DRAG_TYPE }

export type SessionSidebarDragPayload =
  | { kind: 'row'; sessionKey: string }
  | { kind: 'group'; groupKey: string }

type DragData = Pick<DataTransfer, 'setData' | 'getData' | 'types'>

export function writeSessionSidebarDrag(data: DragData, payload: SessionSidebarDragPayload): void {
  if (payload.kind === 'row') {
    data.setData(SESSION_ROW_DRAG_TYPE, payload.sessionKey)
  } else {
    data.setData(SESSION_GROUP_DRAG_TYPE, payload.groupKey)
  }
}

export function readSessionSidebarDragKind(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): SessionSidebarDragPayload['kind'] | null {
  const list = types ? Array.from(types) : []
  if (list.includes(SESSION_ROW_DRAG_TYPE)) {
    return 'row'
  }
  if (list.includes(SESSION_GROUP_DRAG_TYPE)) {
    return 'group'
  }
  return null
}

export function readSessionSidebarDrag(data: DragData): SessionSidebarDragPayload | null {
  const kind = readSessionSidebarDragKind(data.types)
  if (kind === 'row') {
    const sessionKey = data.getData(SESSION_ROW_DRAG_TYPE)
    return sessionKey ? { kind, sessionKey } : null
  }
  if (kind === 'group') {
    const groupKey = data.getData(SESSION_GROUP_DRAG_TYPE)
    return groupKey ? { kind, groupKey } : null
  }
  return null
}

/**
 * Where a folder dropped on a reorderable folder's header lands: the top and bottom quarters
 * place it before or after, the middle puts it inside.
 */
export function resolveFolderHeaderZone(
  clientY: number,
  rect: Pick<DOMRect, 'top' | 'height'>
): 'before' | 'after' | 'into' {
  const offset = clientY - rect.top
  if (offset < rect.height / 4) {
    return 'before'
  }
  return offset > (rect.height * 3) / 4 ? 'after' : 'into'
}

/** Which side of a header a drop lands on, by pointer position over the header box. */
export function resolveGroupDropPosition(
  clientY: number,
  rect: Pick<DOMRect, 'top' | 'height'>
): 'before' | 'after' {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * Everything a drag carries when it starts on a selected item: the selected sessions and the
 * selected folders (each with everything inside it) move together to wherever it is dropped.
 */
export type SessionSidebarDragBatch = {
  sessionKeys: readonly string[]
  folderIds: readonly string[]
  /** The picked folders and everything nested under them — never a place the batch can go. */
  blockedFolderIds: readonly string[]
}

export type SessionSidebarDragInFlight =
  | {
      kind: 'row'
      sessionKey: string
      workspaceGroupKey: string
      batch?: SessionSidebarDragBatch
    }
  | {
      kind: 'group'
      groupKey: string
      canReorder?: boolean
      batch?: SessionSidebarDragBatch
      /** Set when the dragged group is a folder: what it may land in. */
      folder?: {
        id: string
        parentId: string | null
        section: SessionFolderSection
        /** Itself and everything nested under it — never a place it can go. */
        subtreeIds: readonly string[]
      }
    }

// Why module state: dragover cannot read dataTransfer payloads, and React state
// set inside dragstart mutates the document, which makes Chromium cancel the drag.
let inFlight: SessionSidebarDragInFlight | null = null

export function beginSessionSidebarDrag(payload: SessionSidebarDragInFlight): void {
  inFlight = payload
}

export function getSessionSidebarDrag(): SessionSidebarDragInFlight | null {
  return inFlight
}

export function clearSessionSidebarDrag(): void {
  inFlight = null
}

export type SessionGroupDropTarget =
  | { kind: 'row'; folderId: string | null }
  | { kind: 'group'; position: 'before' | 'after' }
  /** A folder (with its subfolders and sessions) goes inside `parentId`, or the top of `section`. */
  | { kind: 'folder'; parentId: string | null; section: SessionFolderSection }

function resolveFolderInto(
  drag: Extract<SessionSidebarDragInFlight, { kind: 'group' }>,
  group: { key: string; kind: SessionSidebarGroupKind; folderId: string | null },
  section: SessionFolderSection | undefined
): SessionGroupDropTarget | null {
  const folder = drag.folder
  if (!folder) {
    return null
  }
  // Why: a batch moves other things too, so "already there" for this folder is no reason to refuse.
  const alone = !drag.batch
  if (group.kind === 'saved') {
    return alone && folder.parentId === null && folder.section === 'saved'
      ? null
      : { kind: 'folder', parentId: null, section: 'saved' }
  }
  // Why: "Active" is the top of the Conversations list, where a subfolder or a saved folder is lifted out to.
  if (group.key === 'workspace:other') {
    return alone && folder.parentId === null && folder.section === 'active'
      ? null
      : { kind: 'folder', parentId: null, section: 'active' }
  }
  if (
    group.kind !== 'folder' ||
    !group.folderId ||
    !section ||
    folder.subtreeIds.includes(group.folderId) ||
    drag.batch?.blockedFolderIds.includes(group.folderId) ||
    (alone && folder.parentId === group.folderId)
  ) {
    return null
  }
  return { kind: 'folder', parentId: group.folderId, section }
}

/** What a drag hovering a group header would do there, or null when the header rejects it. */
export function resolveSessionGroupDrop(args: {
  drag: SessionSidebarDragInFlight | null
  group: {
    key: string
    kind: SessionSidebarGroupKind
    folderId: string | null
    canReorder: boolean
    /** The section a folder group sits in; absent for other groups. */
    section?: SessionFolderSection
    /** Graft 2: a paired owner's folder this computer has not received; read-only. */
    readOnlyOwnerFolder?: true
  }
  clientY: number
  rect: Pick<DOMRect, 'top' | 'height'>
  /** A folder's body takes a folder inside it only; reordering needs the header's geometry. */
  zone?: 'header' | 'body'
}): SessionGroupDropTarget | null {
  const { drag, group } = args
  // Why: nothing can be filed into, or nested under, a folder this computer does not hold; the
  // move would only fail ("This folder no longer exists") after the drop lit the group up.
  if (!drag || group.readOnlyOwnerFolder) {
    return null
  }
  if (drag.kind === 'row') {
    // Why: a batch holding folders cannot land inside one of them.
    if (group.folderId && drag.batch?.blockedFolderIds.includes(group.folderId)) {
      return null
    }
    if (group.kind === 'saved') {
      return { kind: 'row', folderId: SAVED_SESSIONS_FOLDER_ID }
    }
    if (group.kind === 'folder') {
      return { kind: 'row', folderId: group.folderId }
    }
    // Returning to an automatic section clears filing without changing execution state.
    if (['completed', 'drafts', 'waiting', 'stopped'].includes(group.kind)) {
      return { kind: 'row', folderId: null }
    }
    // Why: dropping a session back onto its own workspace group unfiles it; other workspaces are not homes for it.
    if (
      group.kind === 'workspace' &&
      (group.key === 'workspace:other' || group.key === drag.workspaceGroupKey)
    ) {
      return { kind: 'row', folderId: null }
    }
    return null
  }
  if (drag.groupKey === group.key) {
    return null
  }
  const into = resolveFolderInto(drag, group, group.section)
  // Why: two top-level folders keep reordering at the heading's edges; its middle nests.
  const canReorder = group.canReorder && drag.canReorder !== false && !drag.batch
  if (args.zone === 'body' || !canReorder) {
    return into
  }
  if (into && group.kind === 'folder') {
    const zone = resolveFolderHeaderZone(args.clientY, args.rect)
    return zone === 'into' ? into : { kind: 'group', position: zone }
  }
  return { kind: 'group', position: resolveGroupDropPosition(args.clientY, args.rect) }
}

/** How long a drag rests on a folded folder (or Saved Sessions) before it opens. */
export const SESSION_DRAG_OPEN_DELAY_MS = 600

/** Whether a drag resting on this group should open it: a folded folder the drag can go into. */
export function opensOnDragHover(
  group: { kind: SessionSidebarGroupKind; collapsed: boolean },
  target: SessionGroupDropTarget | null
): boolean {
  // Why not a reorder: dropping before or after a folder never needs to see inside it.
  return (
    group.collapsed &&
    (group.kind === 'folder' || group.kind === 'saved') &&
    target !== null &&
    target.kind !== 'group'
  )
}
