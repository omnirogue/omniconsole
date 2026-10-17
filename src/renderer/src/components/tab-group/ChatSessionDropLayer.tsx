import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import {
  clearSessionSidebarDrag,
  getSessionSidebarDrag,
  readSessionSidebarDragKind
} from '@/lib/session-sidebar-drag'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { splitWorkspaceIntoSessionGrid } from '@/lib/session-grid-actions'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import {
  chatDropZoneToSplitDirection,
  resolveChatDropZone,
  type ChatDropZone
} from '@/lib/chat-drop-zone'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

// Why a dedicated drop layer (not reusing AiVaultSessionDropLayer's channel):
// that layer is wired to the AI-vault resume drag type; this one answers the
// sidebar session-row drag (`session-sidebar-drag.ts`), which carries a
// `sessionKey` rather than a resumable-session payload. Same mount point and
// shape as AiVaultSessionDropLayer (proven to coexist with the tab-bar's own
// dnd-kit split drags in this exact spot) so it costs nothing extra to reason
// about drag-channel interference.

type ChatDropTarget = {
  groupId: string
  zone: ChatDropZone
  overlayStyle: CSSProperties
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function getZoneOverlayStyle(rect: DOMRect, layerRect: DOMRect, zone: ChatDropZone): CSSProperties {
  const left = rect.left - layerRect.left
  const top = rect.top - layerRect.top
  const width = rect.width
  const height = rect.height

  switch (zone) {
    case 'top':
      return { left, top, width, height: height / 2 }
    case 'bottom':
      return { left, top: top + height / 2, width, height: height / 2 }
    case 'left':
      return { left, top, width: width / 2, height }
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height }
    case 'center':
      return { left, top, width, height }
  }
}

function resolvePaneDropTarget(
  worktreeId: string,
  layerRect: DOMRect,
  point: { x: number; y: number }
): ChatDropTarget | null {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>('[data-tab-group-body-id][data-worktree-id]')
  )
  for (const element of elements) {
    if (element.dataset.worktreeId !== worktreeId) {
      continue
    }
    const groupId = element.dataset.tabGroupBodyId
    const rect = element.getBoundingClientRect()
    if (!groupId || rect.width <= 0 || rect.height <= 0 || !containsPoint(rect, point.x, point.y)) {
      continue
    }
    const zone = resolveChatDropZone({ clientX: point.x, clientY: point.y, rect })
    return { groupId, zone, overlayStyle: getZoneOverlayStyle(rect, layerRect, zone) }
  }
  return null
}

/** Moves/opens `tabId` at `target.groupId`, splitting per `target.zone` unless it's `center`. Reuses the same `dropUnifiedTab` API tab-bar drags use, so an already-open tab is relocated, never duplicated. */
function placeTabAtTarget(tabId: string, target: ChatDropTarget): void {
  const splitDirection = chatDropZoneToSplitDirection(target.zone)
  useAppStore.getState().dropUnifiedTab(tabId, {
    groupId: target.groupId,
    ...(splitDirection ? { splitDirection } : {})
  })
}

function dropSessionOntoTarget(
  sessionKeys: readonly string[],
  worktreeId: string,
  target: ChatDropTarget
): void {
  // Why the Grid for a side: tab-group splits cannot mix workspaces, and people split
  // conversations from many workspaces (and browser tabs) onto one screen.
  if (target.zone !== 'center') {
    splitWorkspaceIntoSessionGrid({
      worktreeId,
      groupId: target.groupId,
      zone: target.zone,
      sessionKeys
    })
    return
  }
  const sessionKey = sessionKeys[0]
  const session = buildSidebarSessions(useAppStore.getState()).find(
    (candidate) => candidate.sessionKey === sessionKey
  )
  if (!session || session.unavailable) {
    toast.error(
      translate(
        'auto.components.tab.group.ChatSessionDropLayer.sessionUnavailable',
        'This conversation is no longer available.'
      )
    )
    return
  }
  if (session.worktreeId !== worktreeId) {
    // Why: the middle means "show it here"; another workspace's tab cannot move into this
    // layout, so open it where it lives.
    openSidebarSession(session)
    return
  }

  if (session.tabId) {
    placeTabAtTarget(session.tabId, target)
    return
  }

  // Why: not open yet — reuse the same activation path a sidebar click uses
  // (dedupes/resumes rather than spawning a second process), then relocate
  // the tab it produced into the requested split.
  void activateSidebarSession(session).then((opened) => {
    if (!opened) {
      toast.error(
        translate(
          'auto.components.tab.group.ChatSessionDropLayer.couldNotOpen',
          'Could not open this conversation.'
        )
      )
      return
    }
    if (opened.handled !== 'opened') {
      return
    }
    const reopened = buildSidebarSessions(useAppStore.getState()).find(
      (candidate) => candidate.sessionKey === sessionKey
    )
    if (reopened?.tabId) {
      placeTabAtTarget(reopened.tabId, target)
    }
  })
}

export default function ChatSessionDropLayer({
  worktreeId,
  enabled
}: {
  worktreeId: string
  enabled: boolean
}): React.JSX.Element {
  const [isDragActive, setIsDragActive] = useState(false)
  const [target, setTarget] = useState<ChatDropTarget | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  const clearDragState = useCallback(() => {
    setIsDragActive(false)
    setTarget(null)
  }, [])

  const updateTarget = useCallback(
    (point: { x: number; y: number }): ChatDropTarget | null => {
      const layerElement = layerRef.current
      if (!layerElement) {
        setTarget(null)
        return null
      }
      const layerRect = layerElement.getBoundingClientRect()
      const nextTarget = resolvePaneDropTarget(worktreeId, layerRect, point)
      setTarget((current) => {
        if (
          current?.groupId === nextTarget?.groupId &&
          current?.zone === nextTarget?.zone &&
          current?.overlayStyle.left === nextTarget?.overlayStyle.left &&
          current?.overlayStyle.top === nextTarget?.overlayStyle.top &&
          current?.overlayStyle.width === nextTarget?.overlayStyle.width &&
          current?.overlayStyle.height === nextTarget?.overlayStyle.height
        ) {
          return current
        }
        return nextTarget
      })
      return nextTarget
    },
    [worktreeId]
  )

  const handleSessionDrop = useCallback(
    (point: { x: number; y: number }): boolean => {
      const layerRect = layerRef.current?.getBoundingClientRect()
      const wasInsideLayer = layerRect ? containsPoint(layerRect, point.x, point.y) : false
      const dropTarget = updateTarget(point) ?? target
      const drag = getSessionSidebarDrag()
      clearDragState()
      clearSessionSidebarDrag()
      if (!dropTarget || drag?.kind !== 'row') {
        return wasInsideLayer
      }
      const sessionKeys = drag.batch?.sessionKeys.length
        ? drag.batch.sessionKeys
        : [drag.sessionKey]
      dropSessionOntoTarget(sessionKeys, worktreeId, dropTarget)
      return true
    },
    [clearDragState, target, updateTarget, worktreeId]
  )

  useEffect(() => {
    if (!enabled) {
      clearDragState()
      return
    }

    const markIfRowDrag = (event: DragEvent): void => {
      if (event.dataTransfer && readSessionSidebarDragKind(event.dataTransfer.types) === 'row') {
        setIsDragActive(true)
      }
    }

    const handleWindowDrop = (event: DragEvent): void => {
      if (!event.dataTransfer || readSessionSidebarDragKind(event.dataTransfer.types) !== 'row') {
        return
      }
      // Why: mirrors AiVaultSessionDropLayer — Electron can accept dragover on
      // the overlay but skip React's delegated drop handler, so a window
      // capture listener keeps the visible target and the committed action in
      // sync with each other.
      if (handleSessionDrop({ x: event.clientX, y: event.clientY })) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('dragenter', markIfRowDrag, true)
    window.addEventListener('dragover', markIfRowDrag, true)
    window.addEventListener('drop', handleWindowDrop, true)
    window.addEventListener('drop', clearDragState)
    window.addEventListener('dragend', clearDragState, true)
    return () => {
      window.removeEventListener('dragenter', markIfRowDrag, true)
      window.removeEventListener('dragover', markIfRowDrag, true)
      window.removeEventListener('drop', handleWindowDrop, true)
      window.removeEventListener('drop', clearDragState)
      window.removeEventListener('dragend', clearDragState, true)
    }
  }, [clearDragState, enabled, handleSessionDrop])

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readSessionSidebarDragKind(event.dataTransfer.types) !== 'row') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setIsDragActive(true)
      const nextTarget = updateTarget({ x: event.clientX, y: event.clientY })
      event.dataTransfer.dropEffect = nextTarget ? 'move' : 'none'
    },
    [updateTarget]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readSessionSidebarDragKind(event.dataTransfer.types) !== 'row') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      handleSessionDrop({ x: event.clientX, y: event.clientY })
    },
    [handleSessionDrop]
  )

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setTarget(null)
  }, [])

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      data-chat-session-drop-layer="true"
      data-worktree-id={worktreeId}
      className={`absolute inset-0 z-[10000] ${
        isDragActive ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {isDragActive && target ? (
        <div className="tab-drop-overlay absolute" style={target.overlayStyle}>
          {target.zone !== 'center' ? (
            <span className="tab-drop-overlay__label pointer-events-none absolute bottom-2 left-2 rounded-sm px-1.5 py-0.5 font-medium">
              {translate(
                'auto.components.tab.group.ChatSessionDropLayer.gridSplitLabel',
                'Side by side in the Grid'
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
