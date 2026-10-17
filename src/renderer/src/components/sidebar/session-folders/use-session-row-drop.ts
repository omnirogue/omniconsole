import { useMemo } from 'react'
import { readSessionSidebarDrag, readSessionSidebarDragKind } from '@/lib/session-sidebar-drag'

/** The drop target a row is for another row; nothing when the row cannot take a drop. */
export function useSessionRowDrop(onDropRow: ((sessionKey: string) => void) | undefined): {
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void
} {
  return useMemo(() => {
    if (!onDropRow) {
      return {}
    }
    return {
      onDragOver: (event) => {
        if (readSessionSidebarDragKind(event.dataTransfer.types) === 'row') {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }
      },
      onDrop: (event) => {
        const drag = readSessionSidebarDrag(event.dataTransfer)
        if (drag?.kind === 'row') {
          event.preventDefault()
          event.stopPropagation()
          onDropRow(drag.sessionKey)
        }
      }
    }
  }, [onDropRow])
}
