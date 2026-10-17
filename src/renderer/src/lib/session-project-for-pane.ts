import type { AppState } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'

/**
 * The project folder a pane works in, counted as the project page counts threads: filed in the
 * project, its chat, or a worker one of those started. Null when it is in none.
 */
export function sessionProjectForPane(
  state: AppState,
  paneKey: string,
  now: number = Date.now()
): string | null {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
  const projects = Object.keys(useSessionFolders.getState().metadata.projects ?? {})
  return (
    projects.find((projectFolderId) =>
      buildSessionManageSidebarRows(state, now, { projectFolderId }).some(
        (row) => row.paneKey === paneKey && row.projectThread !== undefined
      )
    ) ?? null
  )
}
