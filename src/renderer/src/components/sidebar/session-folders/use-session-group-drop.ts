import { useLaunchIntentDrop } from './use-launch-intent-drop'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  getSessionSidebarDrag,
  opensOnDragHover,
  readSessionSidebarDrag,
  readSessionSidebarDragKind,
  resolveSessionGroupDrop,
  SESSION_DRAG_OPEN_DELAY_MS,
  writeSessionSidebarDrag,
  type SessionGroupDropTarget
} from '@/lib/session-sidebar-drag'
import type { SessionFolder } from '@/lib/session-folders'
import { sessionFolderSubtreeIds, type SessionFolderSection } from '@/lib/session-folder-tree'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import { moveSessionSidebarBatch, sessionSidebarDragBatch } from './session-sidebar-batch'
import { openSessionGroupsForDrag } from './use-session-folder-auto-collapse'

function sameDropTarget(
  previous: SessionGroupDropTarget | null,
  next: SessionGroupDropTarget
): boolean {
  if (!previous || previous.kind !== next.kind) {
    return false
  }
  if (previous.kind === 'row' && next.kind === 'row') {
    return previous.folderId === next.folderId
  }
  if (previous.kind === 'folder' && next.kind === 'folder') {
    return previous.parentId === next.parentId && previous.section === next.section
  }
  return previous.kind === 'group' && next.kind === 'group' && previous.position === next.position
}

function folderSection(folder: SessionFolder | undefined): SessionFolderSection | undefined {
  return folder ? (folder.section === 'saved' ? 'saved' : 'active') : undefined
}

/**
 * Drag-and-drop for one group in the Conversations tree: rows file into it, folders reorder
 * around it, and a folder dropped on a folder goes inside it with its subfolders and sessions.
 * A folded folder (or Saved Sessions) the drag rests on opens after SESSION_DRAG_OPEN_DELAY_MS.
 */
export function useSessionGroupDrop(args: {
  group: Pick<
    SessionSidebarGroup,
    'key' | 'kind' | 'canReorder' | 'folder' | 'collapsed' | 'readOnlyOwnerFolder'
  >
  launchFolderId?: string
  folders: readonly SessionFolder[]
  onMoveGroup: (key: string, target: string, position: 'before' | 'after') => void
  onMoveSessionKey: (sessionKey: string, folderId: string | null) => void
  onMoveFolder?: (folderId: string, parentId: string | null, section: SessionFolderSection) => void
}) {
  const { group, folders, onMoveGroup, onMoveSessionKey, onMoveFolder } = args
  const folderId = group.folder?.id ?? null
  // Why no launch into an owner's folder (graft 2): a conversation started here cannot be filed
  // in a folder this computer does not hold.
  const launchDrop = useLaunchIntentDrop(
    group.kind === 'folder' && args.launchFolderId && !group.readOnlyOwnerFolder
      ? { folderId: args.launchFolderId }
      : undefined
  )
  const section = folderSection(group.folder)
  const draggable = group.canReorder || Boolean(group.folder && onMoveFolder)
  const [dropTarget, setDropTarget] = useState<SessionGroupDropTarget | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])
  useEffect(() => cancelOpen, [cancelOpen])

  const handleHeaderDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggable) {
        return
      }
      event.dataTransfer.effectAllowed = 'move'
      writeSessionSidebarDrag(event.dataTransfer, { kind: 'group', groupKey: group.key })
      const folder = group.folder
      const batch =
        folder && onMoveFolder ? sessionSidebarDragBatch({ folderId: folder.id }) : undefined
      beginSessionSidebarDrag({
        kind: 'group',
        groupKey: group.key,
        canReorder: group.canReorder,
        ...(batch ? { batch } : {}),
        ...(folder && onMoveFolder
          ? {
              folder: {
                id: folder.id,
                parentId: folder.parentId ?? null,
                section: folderSection(folder)!,
                subtreeIds: [...sessionFolderSubtreeIds(folders, folder.id)]
              }
            }
          : {})
      })
    },
    [draggable, folders, group.canReorder, group.folder, group.key, onMoveFolder]
  )

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const kind = readSessionSidebarDragKind(event.dataTransfer.types)
      if (!kind) {
        return
      }
      const target = resolveSessionGroupDrop({
        drag: getSessionSidebarDrag(),
        group: {
          key: group.key,
          kind: group.kind,
          folderId,
          canReorder: group.canReorder,
          section,
          ...(group.readOnlyOwnerFolder ? { readOnlyOwnerFolder: true as const } : {})
        },
        clientY: event.clientY,
        rect: event.currentTarget.getBoundingClientRect(),
        zone: event.currentTarget.dataset.sessionGroupZone === 'body' ? 'body' : 'header'
      })
      if (!target) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      // Why: dragover fires continuously; keep the same object while the verdict is unchanged so React bails out.
      setDropTarget((previous) => (sameDropTarget(previous, target) ? previous : target))
      if (!opensOnDragHover({ kind: group.kind, collapsed: group.collapsed }, target)) {
        cancelOpen()
      } else if (openTimer.current === null) {
        openTimer.current = setTimeout(() => {
          openTimer.current = null
          openSessionGroupsForDrag([group.key])
        }, SESSION_DRAG_OPEN_DELAY_MS)
      }
    },
    [
      cancelOpen,
      folderId,
      group.canReorder,
      group.collapsed,
      group.key,
      group.kind,
      group.readOnlyOwnerFolder,
      section
    ]
  )

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTarget(null)
        cancelOpen()
      }
    },
    [cancelOpen]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      setDropTarget(null)
      cancelOpen()
      const payload = readSessionSidebarDrag(event.dataTransfer)
      const inFlight = getSessionSidebarDrag()
      const target = resolveSessionGroupDrop({
        drag:
          inFlight ??
          (payload?.kind === 'row'
            ? { kind: 'row', sessionKey: payload.sessionKey, workspaceGroupKey: '' }
            : payload),
        group: {
          key: group.key,
          kind: group.kind,
          folderId,
          canReorder: group.canReorder,
          section,
          ...(group.readOnlyOwnerFolder ? { readOnlyOwnerFolder: true as const } : {})
        },
        clientY: event.clientY,
        rect: event.currentTarget.getBoundingClientRect(),
        zone: event.currentTarget.dataset.sessionGroupZone === 'body' ? 'body' : 'header'
      })
      if (!payload || !target) {
        return
      }
      event.preventDefault()
      if (inFlight?.batch && target.kind !== 'group') {
        moveSessionSidebarBatch(inFlight.batch, target)
      } else if (target.kind === 'row' && payload.kind === 'row') {
        onMoveSessionKey(payload.sessionKey, target.folderId)
      } else if (target.kind === 'group' && payload.kind === 'group') {
        onMoveGroup(payload.groupKey, group.key, target.position)
      } else if (target.kind === 'folder' && inFlight?.kind === 'group' && inFlight.folder) {
        onMoveFolder?.(inFlight.folder.id, target.parentId, target.section)
      }
      clearSessionSidebarDrag()
    },
    [
      cancelOpen,
      folderId,
      group.canReorder,
      group.key,
      group.kind,
      group.readOnlyOwnerFolder,
      onMoveFolder,
      onMoveGroup,
      onMoveSessionKey,
      section
    ]
  )

  // Why: the body files a session, or puts a folder, into this folder — nothing else. Group
  // reordering stays on the header, where above/below the midpoint is what "before" and
  // "after" mean; the body marks itself (data-session-group-zone) so the resolver knows.
  const handleBodyDragOver = handleDragOver
  const handleBodyDrop = handleDrop

  return {
    launchOver: launchDrop.over,
    launchIntentHandlers: {
      'data-launch-drag-over': launchDrop.over || undefined,
      onDragOverCapture: launchDrop.onDragOver,
      onDropCapture: launchDrop.onDrop,
      onDragLeaveCapture: launchDrop.onDragLeave
    },
    draggable,
    dropTarget,
    handleHeaderDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleBodyDragOver,
    handleBodyDrop
  }
}
