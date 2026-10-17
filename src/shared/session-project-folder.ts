import { COMPANY_NAME } from './company-identity'

/** The folder fields the project rule reads; the renderer's `SessionFolder` satisfies it. */
export type ProjectFolderNode = { id: string; name: string; parentId?: string; section?: 'saved' }

export const KNOWN_COMPANY_FOLDER_NAMES: ReadonlyMap<string, string> = new Map(
  [...Object.values(COMPANY_NAME), 'OmniOS'].map((name) => [name.toLowerCase(), name])
)

export function isCompanyFolderName(name: string): boolean {
  return KNOWN_COMPANY_FOLDER_NAMES.has(name.trim().toLowerCase())
}

/** The folder and its ancestors, top first; a looped parent link stops the walk. */
export function sessionFolderChain<T extends ProjectFolderNode>(
  folders: readonly T[],
  folderId: string | null | undefined
): T[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const chain: T[] = []
  let folder = folderId ? byId.get(folderId) : undefined
  while (folder && !chain.includes(folder)) {
    chain.unshift(folder)
    folder = folder.parentId ? byId.get(folder.parentId) : undefined
  }
  return chain
}

/**
 * Group-by project's rule: a top-level folder named after a company holds projects, so its
 * children are the projects; any other top-level folder is one. Null for an unfiled session and
 * for a company folder itself.
 */
export function projectFolderFor<T extends ProjectFolderNode>(
  folders: readonly T[],
  folderId: string | null | undefined
): T | null {
  const chain = sessionFolderChain(folders, folderId)
  const root = chain[0]
  if (!root) {
    return null
  }
  return isCompanyFolderName(root.name) ? (chain[1] ?? null) : root
}

/** Whether this folder is itself a project (not a subfolder inside one, nor a company folder). */
export function isProjectFolder(folders: readonly ProjectFolderNode[], folderId: string): boolean {
  return projectFolderFor(folders, folderId)?.id === folderId
}
