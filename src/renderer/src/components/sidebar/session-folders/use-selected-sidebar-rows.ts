import { useMemo } from 'react'
import type { ConversationFleetSidebarRow } from '@/lib/conversation-fleet-sidebar'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'
import type { SessionFolderSection } from '@/lib/session-folder-tree'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from '@/lib/session-folders'
import { moveFolderByPerson } from '@/lib/session-organization-person-changes'
import { sessionFolderGroupKey } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { isRoutineViewKey } from '../routines/routine-view-key'
import type { visibleSessionSelection } from './session-multi-selection'

/** Selected conversations, receipts from other computers and routines, in the order shown. */
export function useSelectedSidebarRows(
  visible: ReturnType<typeof visibleSessionSelection>,
  selectedKeys: ReadonlySet<string>
): {
  sessions: SidebarSession[]
  fleet: ConversationFleetSidebarRow[]
  routines: ConversationRoutineRow[]
  count: number
} {
  return useMemo(() => {
    const sessions: SidebarSession[] = []
    const fleet: ConversationFleetSidebarRow[] = []
    const routines: ConversationRoutineRow[] = []
    for (const key of visible.order) {
      if (!selectedKeys.has(key)) {
        continue
      }
      const session = visible.byKey.get(key)
      const fleetRow = visible.fleetByKey.get(key)
      const routine = visible.routinesByKey.get(key)
      if (session) {
        sessions.push(session)
      } else if (fleetRow) {
        fleet.push(fleetRow)
      } else if (routine) {
        routines.push(routine)
      }
    }
    return { sessions, fleet, routines, count: sessions.length + fleet.length + routines.length }
  }, [selectedKeys, visible])
}

/** How many sessions the compact bulk panel acts on; a selected routine belongs to the bulk bar. */
export function useSelectedSessionCount(): number {
  return useSessionSelection((state) =>
    state.explicit ? state.keys.filter((key) => !isRoutineViewKey(key)).length : 0
  )
}

/** Folders picked on their heading that still exist, in folder order. */
export function usePickedFolderIds(folders: readonly SessionFolder[]): string[] {
  const picked = useSessionSelection((state) => state.folderIds)
  return useMemo(
    () => folders.filter((folder) => picked.has(folder.id)).map((folder) => folder.id),
    [folders, picked]
  )
}

/** Moves a folder (with its subfolders and sessions) and unfolds its destination, so the move is seen landing there. */
export function moveSavedFolder(
  folderId: string,
  parentId: string | null,
  section?: SessionFolderSection
): boolean {
  const moved = moveFolderByPerson(folderId, parentId, section)
  if (moved) {
    useSessionSidebarView
      .getState()
      .setCollapsed(
        parentId
          ? [sessionFolderGroupKey(parentId)]
          : section === 'saved'
            ? [SAVED_SESSIONS_FOLDER_ID]
            : [],
        false
      )
  }
  return moved
}
