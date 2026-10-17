import { useCallback, useState } from 'react'
import {
  clearSessionSidebarDrag,
  getSessionSidebarDrag,
  readSessionSidebarDrag,
  readSessionSidebarDragKind
} from '@/lib/session-sidebar-drag'
import { moveSessionsByPerson } from '@/lib/session-organization-person-changes'
import { offerProjectContext } from '@/lib/session-project-context-offer'

/** The sessions a dropped row carries: the picked batch when it is sessions only, else the row. */
export function droppedSessionKeys(
  payloadKey: string | null,
  batch: { sessionKeys: readonly string[]; folderIds: readonly string[] } | undefined
): string[] {
  if (batch && batch.folderIds.length === 0 && batch.sessionKeys.length > 0) {
    return [...batch.sessionKeys]
  }
  return payloadKey ? [payloadKey] : []
}

/** Lets a session row dragged from the sidebar be filed into a project, then offers its context. */
export function useProjectSessionDrop(folderId: string) {
  const [over, setOver] = useState(false)
  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (readSessionSidebarDragKind(event.dataTransfer.types) !== 'row') {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }, [])
  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOver(false)
    }
  }, [])
  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      setOver(false)
      const payload = readSessionSidebarDrag(event.dataTransfer)
      if (payload?.kind !== 'row') {
        return
      }
      event.preventDefault()
      const keys = droppedSessionKeys(payload.sessionKey, getSessionSidebarDrag()?.batch)
      clearSessionSidebarDrag()
      if (keys.length > 0 && moveSessionsByPerson(keys, folderId)) {
        offerProjectContext(keys, folderId)
      }
    },
    [folderId]
  )
  return {
    over,
    handlers: { onDragOver, onDragLeave, onDrop, 'data-session-project-drop': over || undefined }
  }
}
