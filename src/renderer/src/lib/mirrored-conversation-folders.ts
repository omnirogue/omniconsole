import {
  getSessionFolderId,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder,
  type SessionFolderMetadata
} from './session-folders'
import type { SidebarSession } from './sidebar-session-types'

/**
 * The folder a sidebar row is filed in (addendum C3, one resolver for the tree, management and
 * project rows): for a row a paired owner's ledger vouches for, the owner's explicit folder wins
 * over this computer's membership; absent means the owner did not say, so the local (account
 * synced) membership stands as the last known placement.
 */
export function sessionRowFolderId(
  metadata: SessionFolderMetadata,
  session: Pick<SidebarSession, 'mirroredConversation'>,
  viewKey: string
): string | null {
  const owner = session.mirroredConversation
  if (owner?.folderIdByOwner === undefined) {
    return getSessionFolderId(metadata, viewKey)
  }
  const id = owner.folderIdByOwner
  // Why: a folder neither computer can name reads unfiled, never as a stale local placement.
  return id !== null &&
    (id === SAVED_SESSIONS_FOLDER_ID ||
      metadata.folders.some((folder) => folder.id === id) ||
      owner.folderByOwner?.id === id)
    ? id
    : null
}

/**
 * Graft 2: owner folders that rows are filed in but this computer has not received yet. They list
 * as read-only groups until account sync delivers the folder itself (ids are shared, C8). Saved
 * Sessions folders are not drawn here; their rows list under Active meanwhile.
 */
export function readOnlyOwnerFolders(
  local: readonly SessionFolder[],
  rows: readonly { session: SidebarSession; folderId: string | null }[]
): SessionFolder[] {
  const known = new Set(local.map((folder) => folder.id))
  const found = new Map<string, SessionFolder>()
  for (const { session, folderId } of rows) {
    const folder = session.mirroredConversation?.folderByOwner
    if (
      folder &&
      folder.id === folderId &&
      folder.section !== 'saved' &&
      !known.has(folder.id) &&
      !found.has(folder.id)
    ) {
      found.set(folder.id, {
        id: folder.id,
        name: folder.name,
        ...(folder.parentId ? { parentId: folder.parentId } : {})
      })
    }
  }
  return [...found.values()]
}
