import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveChatDropZone } from '@/lib/chat-drop-zone'
import {
  captureSessionGridDrag,
  dropOnSessionGrid,
  type SessionGridDragCapture
} from '@/lib/session-grid-actions'
import { clearSessionGridDrag, isSessionGridDropTypes } from '@/lib/session-grid-drag'
import type { SessionGridDropZone } from '@/lib/session-grid-layout'

export type SessionGridDropTarget = {
  paneId: string | null
  zone: SessionGridDropZone
  /** Where the highlight goes, in px from the grid body's corner. */
  box: { left: number; top: number; width: number; height: number }
}

function zoneBox(
  rect: DOMRect,
  body: DOMRect,
  zone: SessionGridDropZone
): SessionGridDropTarget['box'] {
  const left = rect.left - body.left
  const top = rect.top - body.top
  switch (zone) {
    case 'left':
      return { left, top, width: rect.width / 2, height: rect.height }
    case 'right':
      return { left: left + rect.width / 2, top, width: rect.width / 2, height: rect.height }
    case 'top':
      return { left, top, width: rect.width, height: rect.height / 2 }
    case 'bottom':
      return { left, top: top + rect.height / 2, width: rect.width, height: rect.height / 2 }
    case 'center':
      return { left, top, width: rect.width, height: rect.height }
  }
}

export function sessionGridDropTargetAt(
  body: HTMLElement,
  point: { x: number; y: number }
): SessionGridDropTarget {
  const bodyRect = body.getBoundingClientRect()
  for (const pane of body.querySelectorAll<HTMLElement>('[data-session-grid-pane]')) {
    if (pane.closest('[inert]')) {
      continue
    }
    const rect = pane.getBoundingClientRect()
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      const zone = resolveChatDropZone({ clientX: point.x, clientY: point.y, rect })
      return {
        paneId: pane.dataset.sessionGridPane ?? null,
        zone,
        box: zoneBox(rect, bodyRect, zone)
      }
    }
  }
  return {
    paneId: null,
    zone: 'center',
    box: { left: 0, top: 0, width: bodyRect.width, height: bodyRect.height }
  }
}

/**
 * The Grid's drop surface. A cover goes over the whole grid the moment a grid-shaped drag
 * starts anywhere — a borrowed terminal and a webview both swallow drag events, so the grid
 * body under them would never hear the drop.
 */
export function useSessionGridDrop(bodyRef: React.RefObject<HTMLElement | null>): {
  active: boolean
  target: SessionGridDropTarget | null
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDrop: (event: React.DragEvent<HTMLElement>) => void
} {
  const [active, setActive] = useState(false)
  const [target, setTarget] = useState<SessionGridDropTarget | null>(null)
  const targetRef = useRef<SessionGridDropTarget | null>(null)
  const capturedRef = useRef<SessionGridDragCapture | null>(null)

  const clear = useCallback(() => {
    setActive(false)
    setTarget(null)
    targetRef.current = null
    capturedRef.current = null
  }, [])

  const update = useCallback(
    (point: { x: number; y: number }): SessionGridDropTarget | null => {
      const body = bodyRef.current
      const next = body ? sessionGridDropTargetAt(body, point) : null
      targetRef.current = next
      const captured = captureSessionGridDrag()
      if (captured.payload || captured.sidebarKeys.length > 0) {
        capturedRef.current = captured
      }
      setTarget((current) =>
        current?.paneId === next?.paneId &&
        current?.zone === next?.zone &&
        current?.box.left === next?.box.left &&
        current?.box.top === next?.box.top &&
        current?.box.width === next?.box.width &&
        current?.box.height === next?.box.height
          ? current
          : next
      )
      return next
    },
    [bodyRef]
  )

  const commit = useCallback(
    (point: { x: number; y: number }): boolean => {
      const body = bodyRef.current
      const rect = body?.getBoundingClientRect()
      const inside =
        rect !== undefined &&
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      const next = inside ? (update(point) ?? targetRef.current) : null
      const captured = capturedRef.current ?? captureSessionGridDrag()
      clear()
      if (!next) {
        return false
      }
      return dropOnSessionGrid(
        next.paneId ? { paneId: next.paneId, zone: next.zone } : null,
        captured
      )
    },
    [bodyRef, clear, update]
  )

  useEffect(() => {
    const mark = (event: DragEvent): void => {
      if (isSessionGridDropTypes(event.dataTransfer?.types)) {
        setActive(true)
      }
    }
    const drop = (event: DragEvent): void => {
      if (!isSessionGridDropTypes(event.dataTransfer?.types)) {
        return
      }
      // Why a window listener too: Electron can accept dragover on the cover yet skip React's
      // delegated drop (see ChatSessionDropLayer).
      if (commit({ x: event.clientX, y: event.clientY })) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const end = (): void => {
      clearSessionGridDrag()
      clear()
    }
    window.addEventListener('dragenter', mark, true)
    window.addEventListener('dragover', mark, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', end, true)
    return () => {
      window.removeEventListener('dragenter', mark, true)
      window.removeEventListener('dragover', mark, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', end, true)
    }
  }, [clear, commit])

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!isSessionGridDropTypes(event.dataTransfer.types)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      update({ x: event.clientX, y: event.clientY })
    },
    [update]
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!isSessionGridDropTypes(event.dataTransfer.types)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      commit({ x: event.clientX, y: event.clientY })
    },
    [commit]
  )

  return { active, target, onDragOver, onDrop }
}
