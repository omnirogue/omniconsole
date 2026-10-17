import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { sessionWorkOwner } from '@/components/native-chat/session-work-owner'
import { launchProjectIn } from './project-launch'
import { getSessionFolderId, type SessionFolderMetadata } from './session-folders'
import { buildPaneSessions, type SidebarSessionSource } from './sidebar-sessions'

/**
 * The project folder a session is filed in, or null: unfiled, in a plain folder, or in a folder
 * that is not set up as a project. A subfolder resolves to its project, so prepared sessions land
 * at the project root and inherit its settings.
 */
export function sessionPrepProjectFolder(
  metadata: SessionFolderMetadata,
  sessionKey: string | null
): string | null {
  return launchProjectIn(metadata, getSessionFolderId(metadata, sessionKey))?.folderId ?? null
}

/** The same for the conversation a pane is, read at the keystroke like `conversationSourceForPane`. */
export function sessionPrepProjectFolderForPane(paneKey: string, tabId: string): string | null {
  const sessions = buildPaneSessions(useAppStore.getState() as unknown as SidebarSessionSource)
  const owner = sessionWorkOwner(sessions, paneKey, tabId)
  return owner
    ? sessionPrepProjectFolder(useSessionFolders.getState().metadata, owner.sessionKey)
    : null
}
