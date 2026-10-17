import { createLocalSessionFolderStorage } from '@/lib/session-folder-storage'
import { createLocalSessionSidebarViewStorage } from '@/lib/session-sidebar-view-storage'
import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'
import { getSessionFolderId } from '@/lib/session-folders'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { isRoutineViewKey } from './routine-view-key'

/**
 * Routines are listed with the conversations, so filing, hiding and archiving a routine use the
 * Conversations stores themselves. Routine keys (`routine:…`) never collide with a session's.
 */
export const useRoutineFolders = useSessionFolders
export const useRoutineSidebarView = useSessionSidebarView

/** The per-device slots the retired Routines tab kept its own folders and view in. */
export const ROUTINE_FOLDERS_STORAGE_KEY = 'omni.routine-folders.v1'
export const ROUTINE_SIDEBAR_VIEW_STORAGE_KEY = 'omni.routine-sidebar-view.v1'
export const ROUTINE_SIDEBAR_ARCHIVED_STORAGE_KEY = 'omni.routine-sidebar-archived.v1'
export const ROUTINE_SIDEBAR_MERGED_STORAGE_KEY = 'omni.routine-sidebar-merged.v1'

type LegacyStorage = Pick<Storage, 'getItem' | 'setItem'>

function readLegacyArchived(storage: LegacyStorage): string[] {
  const raw = readPersonalView(storage, ROUTINE_SIDEBAR_ARCHIVED_STORAGE_KEY)
  const parsed: unknown = raw === null ? [] : JSON.parse(raw)
  return Array.isArray(parsed)
    ? parsed.filter((key): key is string => typeof key === 'string' && isRoutineViewKey(key))
    : []
}

/**
 * Carries what the person filed on the retired Routines tab into Conversations, once: each routine
 * folder becomes (or joins, by name) a conversation folder holding the same routines, and routines
 * hidden or archived there stay hidden or archived. Both stores must be loaded first.
 */
export function mergeLegacyRoutineSidebar(
  storage: LegacyStorage = localStorage,
  folderStore: Pick<typeof useSessionFolders, 'getState'> = useSessionFolders,
  viewStore: Pick<typeof useSessionSidebarView, 'getState'> = useSessionSidebarView
): void {
  const mergedKey = personalViewStorageKey(ROUTINE_SIDEBAR_MERGED_STORAGE_KEY)
  if (storage.getItem(mergedKey) !== null) {
    return
  }
  const folders = folderStore.getState()
  const view = viewStore.getState()
  if (!folders.loaded || !view.loaded) {
    return
  }
  try {
    const legacy = createLocalSessionFolderStorage(
      () => storage,
      ROUTINE_FOLDERS_STORAGE_KEY
    ).load()
    for (const folder of legacy.folders.filter((entry) => entry.section !== 'saved')) {
      const keys = Object.keys(legacy.membership).filter(
        (key) => isRoutineViewKey(key) && getSessionFolderId(legacy, key) === folder.id
      )
      if (keys.length === 0) {
        continue
      }
      const current = folderStore.getState().metadata.folders
      const existing = current.find(
        (entry) =>
          entry.section !== 'saved' && entry.name.toLowerCase() === folder.name.toLowerCase()
      )
      const id = existing?.id ?? folderStore.getState().createFolder(folder.name)
      if (id) {
        folderStore.getState().moveSessions(keys, id)
      }
    }
    const legacyView = createLocalSessionSidebarViewStorage(
      () => storage,
      ROUTINE_SIDEBAR_VIEW_STORAGE_KEY
    ).load()
    // Why: a routine hidden by hand is stored as `routine:<routine key>`, never a group key.
    const hidden = legacyView.hidden.filter(
      (key) => key.startsWith('routine:') && isRoutineViewKey(key.slice('routine:'.length))
    )
    if (hidden.length > 0) {
      view.setHiddenMany(hidden, true)
    }
    const archived = [...readLegacyArchived(storage), ...(legacyView.archived ?? [])].filter(
      isRoutineViewKey
    )
    if (archived.length > 0) {
      view.setArchived([...new Set(archived)], true)
    }
  } catch (error) {
    // Why: a corrupt legacy slot must not keep the list from opening; the routines stay listed.
    console.warn('[routines] could not carry Routines tab folders into Conversations', error)
  }
  storage.setItem(mergedKey, String(Date.now()))
}
