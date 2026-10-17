import type { SessionFolder, SessionFolderMetadata } from './session-folders'

/**
 * Drops a parent link that points at a missing folder, crosses sections or closes a loop, so a
 * hand-edited or half-written store still draws every folder — at the top when its parent is bad.
 */
export function withValidParents(folders: SessionFolder[]): SessionFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const valid = (folder: SessionFolder): boolean => {
    const seen = new Set([folder.id])
    let parentId = folder.parentId
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent || parent.section !== folder.section || seen.has(parentId)) {
        return false
      }
      seen.add(parentId)
      parentId = parent.parentId
    }
    return true
  }
  return folders.map((folder) => {
    if (!folder.parentId || valid(folder)) {
      return folder
    }
    const { parentId: _dropped, ...rest } = folder
    return rest
  })
}

/** The folder and every folder nested under it, at any depth. */
export function sessionFolderSubtreeIds(
  folders: readonly SessionFolder[],
  folderId: string
): Set<string> {
  const ids = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        grew = true
      }
    }
  }
  return ids
}

/** "Clients / Acme / Q3" — where a nested folder sits, for pickers that list folders flat. */
export function sessionFolderPath(
  folders: readonly SessionFolder[],
  folder: SessionFolder
): string {
  const byId = new Map(folders.map((entry) => [entry.id, entry]))
  const names = [folder.name]
  const seen = new Set([folder.id])
  let parent = folder.parentId ? byId.get(folder.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name)
    seen.add(parent.id)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return names.join(' / ')
}

/** Folders in tree order — each parent directly before its children — with their depth. */
export function sessionFolderTree(
  folders: readonly SessionFolder[]
): { folder: SessionFolder; depth: number }[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const children = new Map<string | undefined, SessionFolder[]>()
  for (const folder of folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : undefined
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  const ordered: { folder: SessionFolder; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (parent: string | undefined, depth: number): void => {
    for (const folder of children.get(parent) ?? []) {
      if (!seen.has(folder.id)) {
        seen.add(folder.id)
        ordered.push({ folder, depth })
        visit(folder.id, depth + 1)
      }
    }
  }
  visit(undefined, 0)
  return ordered
}

/** Which section a folder sits in: Saved Sessions, or the open Conversations list. */
export type SessionFolderSection = 'saved' | 'active'

/**
 * Puts a folder inside another folder, or at the top of a section with `parentId` null (its own
 * section unless `section` names the other one). A move into a folder of the other section takes
 * that section, and so does everything nested under it — the sessions filed there go with it,
 * which is what saves or unsaves them. Refuses a move into itself or its own subfolders, which
 * would cut the branch off the tree.
 */
export function moveSessionFolder(
  metadata: SessionFolderMetadata,
  folderId: string,
  parentId: string | null,
  section?: SessionFolderSection
): SessionFolderMetadata {
  const folder = metadata.folders.find((entry) => entry.id === folderId)
  if (!folder) {
    throw new Error('This folder no longer exists.')
  }
  let saved = section === undefined ? folder.section === 'saved' : section === 'saved'
  if (parentId !== null) {
    const parent = metadata.folders.find((entry) => entry.id === parentId)
    if (!parent) {
      throw new Error('This folder no longer exists.')
    }
    if (sessionFolderSubtreeIds(metadata.folders, folderId).has(parentId)) {
      throw new Error('A folder cannot go inside itself.')
    }
    saved = parent.section === 'saved'
  }
  const subtree = sessionFolderSubtreeIds(metadata.folders, folderId)
  return {
    ...metadata,
    folders: metadata.folders.map((entry) => {
      if (!subtree.has(entry.id)) {
        return entry
      }
      const { parentId: previousParent, section: _section, ...rest } = entry
      const keptParent = entry.id === folderId ? parentId : (previousParent ?? null)
      return {
        ...rest,
        ...(saved ? { section: 'saved' as const } : {}),
        ...(keptParent ? { parentId: keptParent } : {})
      }
    })
  }
}
