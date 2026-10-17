import type { ConversationRoutineRow as Row } from '@/lib/conversation-routine-rows'
import type { SessionFolder } from '@/lib/session-folders'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  writeSessionSidebarDrag
} from '@/lib/session-sidebar-drag'
import { useSessionSelection } from '@/store/session-selection'
import { RoutineRow } from './RoutineRow'
import type { ConversationRoutines } from './use-conversation-routines'

/** A routine in the Conversations list: opens its conversation, and drags into any folder. */
export function ConversationRoutineRow({
  row,
  currentKey,
  routines,
  folders,
  groupKey
}: {
  row: Row
  /** The row on the main screen (see currentSidebarRowKey). */
  currentKey: string | null
  routines: ConversationRoutines
  folders: readonly SessionFolder[]
  groupKey: string
}): React.JSX.Element {
  // Why: a routine is selected by its `routine:…` key in the same selection as the conversations.
  const selected = useSessionSelection((state) => state.selected.has(row.key))
  return (
    <RoutineRow
      automation={row.automation}
      routineKey={row.key}
      // Why: the routine is current while its conversation is on screen; with no conversation in
      // front (its settings page), the routine picked there is.
      current={
        currentKey !== null ? currentKey === row.key : routines.selectedId === row.automation.id
      }
      opening={routines.openingId === row.automation.id}
      hidden={row.hidden}
      archived={row.archived}
      folders={folders}
      folderId={row.folderId}
      commands={routines.commands}
      onOpen={() => routines.open(row.automation)}
      selected={selected}
      onToggleSelected={() => useSessionSelection.getState().toggle(row.key, 'visible')}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        writeSessionSidebarDrag(event.dataTransfer, {
          kind: 'row',
          sessionKey: row.key
        })
        beginSessionSidebarDrag({
          kind: 'row',
          sessionKey: row.key,
          workspaceGroupKey: groupKey
        })
      }}
      onDragEnd={clearSessionSidebarDrag}
    />
  )
}
