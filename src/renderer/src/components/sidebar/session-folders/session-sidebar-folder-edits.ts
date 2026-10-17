import type { SessionFolder } from '@/lib/session-folders'
import {
  createFolderByPerson,
  deleteFolderByPerson,
  moveSessionsByPerson,
  renameFolderByPerson
} from '@/lib/session-organization-person-changes'
import { offerProjectContext } from '@/lib/session-project-context-offer'

/** The sidebar's folder edits and single-row drops, each one recorded change by the person. */
export const sidebarFolderEdits = {
  create: (name: string, section?: 'saved', parentId?: string): string | null =>
    createFolderByPerson(name, section, parentId),
  createSaved: (name: string, parentId?: string): boolean =>
    createFolderByPerson(name, 'saved', parentId) !== null,
  rename: (folder: SessionFolder, name: string): boolean => renameFolderByPerson(folder.id, name),
  remove: (folder: SessionFolder): boolean => deleteFolderByPerson(folder.id),
  fileSession: (key: string, folderId: string | null): boolean => {
    const moved = moveSessionsByPerson([key], folderId)
    if (moved) {
      offerProjectContext([key], folderId)
    }
    return moved
  }
}
