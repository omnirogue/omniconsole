import type { SessionFolderEntry } from '../../../shared/session-folder-cli'
import { sessionFolderDisplayPath } from '../../../shared/session-folder-ref'
import { ownSessionGroupColor } from './session-folder-colors'
import {
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder,
  type SessionFolderMetadata
} from './session-folders'
import { sessionFolderGroupKey, type SessionSidebarView } from './session-sidebar-view'
import { sessionFolderTree } from './session-folder-tree'

/** One folder as `omni folder list` reports it. */
export function sessionFolderEntry(
  metadata: SessionFolderMetadata,
  view: Pick<SessionSidebarView, 'colors'>,
  folder: SessionFolder
): SessionFolderEntry {
  let sessionCount = 0
  for (const folderId of Object.values(metadata.membership)) {
    if (folderId === folder.id) {
      sessionCount += 1
    }
  }
  return {
    id: folder.id,
    name: folder.name,
    path: sessionFolderDisplayPath(metadata.folders, folder),
    section: folder.section === 'saved' ? 'saved' : 'active',
    parentId: folder.parentId ?? null,
    color: ownSessionGroupColor(view, sessionFolderGroupKey(folder.id)),
    sessionCount
  }
}

/** Every folder in sidebar tree order: open Conversations folders first, then Saved Sessions. */
export function listSessionFolderEntries(
  metadata: SessionFolderMetadata,
  view: Pick<SessionSidebarView, 'colors'>
): SessionFolderEntry[] {
  const tree = sessionFolderTree(metadata.folders).map(({ folder }) => folder)
  return [
    ...tree.filter((folder) => folder.section !== 'saved'),
    ...tree.filter((folder) => folder.section === 'saved')
  ].map((folder) => sessionFolderEntry(metadata, view, folder))
}

/**
 * The collapsible groups to open so `folderId` shows: it and every folder above it, plus Saved
 * Sessions for a saved folder. `null` with `saved` opens just Saved Sessions.
 */
export function sessionFolderRevealKeys(
  metadata: SessionFolderMetadata,
  folderId: string | null,
  saved: boolean
): string[] {
  const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
  const keys: string[] = []
  const seen = new Set<string>()
  let folder = folderId ? byId.get(folderId) : undefined
  const inSaved = folder ? folder.section === 'saved' : saved
  while (folder && !seen.has(folder.id)) {
    keys.unshift(sessionFolderGroupKey(folder.id))
    seen.add(folder.id)
    folder = folder.parentId ? byId.get(folder.parentId) : undefined
  }
  return inSaved ? [SAVED_SESSIONS_FOLDER_ID, ...keys] : keys
}
