import { useCallback, useEffect, useMemo } from 'react'
import type { ConversationFleetSidebarGroup } from '@/lib/conversation-fleet-sidebar'
import {
  addConversationRoutineRows,
  type ConversationRoutineRow as Row
} from '@/lib/conversation-routine-rows'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import type { SessionSidebarView } from '@/lib/session-sidebar-view'
import { ConversationRoutineRow } from './ConversationRoutineRow'
import { routineRowCaption } from './routine-row-details'
import { mergeLegacyRoutineSidebar } from './routine-sidebar-stores'
import { useConversationRoutines } from './use-conversation-routines'

/**
 * A routine is a conversation with a schedule, so the Conversations list lists and files it like
 * one: this adds each routine to the groups and draws its row. The technical Sessions view lists
 * sessions only.
 */
export function useConversationRoutineGroups(
  groups: readonly ConversationFleetSidebarGroup[],
  args: {
    technical: boolean
    folders: { metadata: SessionFolderMetadata; loaded: boolean }
    viewStore: { view: SessionSidebarView; showHidden: boolean; loaded: boolean }
    archivedKeys: ReadonlySet<string>
    query: string
    showArchived: boolean
  }
) {
  const routines = useConversationRoutines()
  const storesLoaded = args.folders.loaded && args.viewStore.loaded
  // Why: folders, hidden and archived routines from the retired Routines tab come along, once.
  useEffect(() => {
    if (storesLoaded) {
      mergeLegacyRoutineSidebar()
    }
  }, [storesLoaded])
  const { technical, archivedKeys, query, showArchived } = args
  const { metadata } = args.folders
  const { view, showHidden } = args.viewStore
  const listed = useMemo(
    () =>
      addConversationRoutineRows({
        groups,
        automations: technical ? [] : routines.automations,
        target: routines.target,
        metadata,
        view,
        archivedKeys,
        query,
        showHidden,
        showArchived,
        scheduleLabel: (automation) => routineRowCaption(automation)[0]!
      }),
    [
      groups,
      technical,
      routines.automations,
      routines.target,
      metadata,
      view,
      archivedKeys,
      query,
      showHidden,
      showArchived
    ]
  )
  const renderRoutineRow = useCallback(
    (row: Row, group: { key: string }, currentKey?: string | null) => (
      <ConversationRoutineRow
        row={row}
        currentKey={currentKey ?? null}
        routines={routines}
        folders={metadata.folders}
        groupKey={group.key}
      />
    ),
    [routines, metadata.folders]
  )
  return { ...listed, renderRoutineRow, commands: routines.commands }
}
