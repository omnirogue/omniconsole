import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  getSessionSidebarDrag,
  readSessionSidebarDrag,
  readSessionSidebarDragKind,
  clearSessionSidebarDrag
} from '@/lib/session-sidebar-drag'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { conversationRoutineSeed } from './conversation-routine-seed'
import { isRoutineViewKey } from './routine-view-key'

/** A routine dragged within its own list is not a conversation to seed a routine from. */
function isRoutineRowDrag(): boolean {
  const drag = getSessionSidebarDrag()
  return drag?.kind === 'row' && isRoutineViewKey(drag.sessionKey)
}

/** Drop a conversation here to start a routine from it. */
export function RoutineDropTarget({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={cn(
        'flex rounded-md data-[drag-over=true]:ring-1 data-[drag-over=true]:ring-ring',
        className
      )}
      data-drag-over={over}
      data-routine-drop-target
      onDragOver={(event) => {
        if (readSessionSidebarDragKind(event.dataTransfer.types) !== 'row' || isRoutineRowDrag()) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOver(false)
        }
      }}
      onDrop={(event) => {
        setOver(false)
        const payload = readSessionSidebarDrag(event.dataTransfer)
        if (payload?.kind !== 'row' || isRoutineViewKey(payload.sessionKey)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        clearSessionSidebarDrag()
        const state = useAppStore.getState()
        const seed = conversationRoutineSeed(state, payload.sessionKey)
        if (!seed) {
          toast.error(
            translate(
              'chatActions.routineUnavailable',
              'Open this conversation on its computer before creating a routine.'
            )
          )
          return
        }
        state.setPendingRoutineDraftSeed(seed)
        state.setActiveView('automations')
      }}
    >
      {children}
    </div>
  )
}
