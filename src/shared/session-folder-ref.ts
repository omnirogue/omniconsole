/**
 * Turns what a person or agent types — a folder id, or a path like "Saved Sessions / Clients / Acme"
 * — into one Conversations-sidebar folder. Pure, so the renderer (which owns the folders) and the
 * CLI (which checks a reference before creating a terminal) resolve it the same way.
 *
 * Paths are case-insensitive and take "/" or " / " between names. A leading "Saved Sessions"
 * limits the search to that section and, on its own, means the Saved Sessions root. A path is
 * matched from the top of its section first; failing that, as the tail of a longer path, so
 * "Acme" finds "Clients / Acme" when it is the only one.
 */

export const SAVED_SESSIONS_LABEL = 'Saved Sessions'
/** Same value as the renderer's SAVED_SESSIONS_FOLDER_ID: the Saved Sessions root itself. */
export const SAVED_SESSIONS_REF_ID = 'saved-sessions'

export type SessionFolderRefNode = {
  id: string
  name: string
  parentId?: string | null
  /** 'saved' for a folder under Saved Sessions; anything else is the open Conversations list. */
  section?: string | null
}

export type SessionFolderRefTarget<T extends SessionFolderRefNode> =
  | { kind: 'folder'; folder: T }
  | { kind: 'saved-root' }

export type SessionFolderRefResult<T extends SessionFolderRefNode> =
  | { ok: true; target: SessionFolderRefTarget<T> }
  | { ok: false; error: string }

const CANDIDATE_LIST_LIMIT = 30

function isSaved(folder: SessionFolderRefNode): boolean {
  return folder.section === 'saved'
}

/** Folder names from the top of its section down to the folder itself. */
export function sessionFolderNameChain<T extends SessionFolderRefNode>(
  folders: readonly T[],
  folder: T
): string[] {
  const byId = new Map(folders.map((entry) => [entry.id, entry]))
  const names = [folder.name]
  const seen = new Set([folder.id])
  let parent = folder.parentId ? byId.get(folder.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name)
    seen.add(parent.id)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return names
}

/** "Saved Sessions / Clients / Acme" for a saved folder, "Clients / Acme" otherwise. */
export function sessionFolderDisplayPath<T extends SessionFolderRefNode>(
  folders: readonly T[],
  folder: T
): string {
  const names = sessionFolderNameChain(folders, folder)
  return (isSaved(folder) ? [SAVED_SESSIONS_LABEL, ...names] : names).join(' / ')
}

/** Lower-cased, trimmed segments; a name that itself holds "/" splits the same way on both sides. */
export function sessionFolderRefSegments(path: string): string[] {
  return path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0)
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function endsWithSegments(path: readonly string[], tail: readonly string[]): boolean {
  return (
    tail.length > 0 &&
    tail.length <= path.length &&
    sameSegments(path.slice(path.length - tail.length), tail)
  )
}

function candidateList<T extends SessionFolderRefNode>(
  folders: readonly T[],
  candidates: readonly T[]
): string {
  const shown = candidates
    .slice(0, CANDIDATE_LIST_LIMIT)
    .map((folder) => `"${sessionFolderDisplayPath(folders, folder)}" (${folder.id})`)
  const more = candidates.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

export function resolveSessionFolderRef<T extends SessionFolderRefNode>(
  folders: readonly T[],
  ref: string
): SessionFolderRefResult<T> {
  const trimmed = ref.trim()
  if (!trimmed) {
    return { ok: false, error: 'Name a folder by its id or its path.' }
  }
  const byId = folders.find((folder) => folder.id === trimmed)
  if (byId) {
    return { ok: true, target: { kind: 'folder', folder: byId } }
  }
  if (trimmed === SAVED_SESSIONS_REF_ID) {
    return { ok: true, target: { kind: 'saved-root' } }
  }
  let wanted = sessionFolderRefSegments(trimmed)
  let pool: readonly T[] = folders
  if (wanted[0] === SAVED_SESSIONS_LABEL.toLowerCase()) {
    wanted = wanted.slice(1)
    if (wanted.length === 0) {
      return { ok: true, target: { kind: 'saved-root' } }
    }
    pool = folders.filter(isSaved)
  }
  if (wanted.length === 0) {
    return { ok: false, error: 'Name a folder by its id or its path.' }
  }
  const paths = pool.map((folder) => ({
    folder,
    segments: sessionFolderRefSegments(sessionFolderNameChain(folders, folder).join('/'))
  }))
  const exact = paths.filter((entry) => sameSegments(entry.segments, wanted))
  const matches =
    exact.length > 0 ? exact : paths.filter((entry) => endsWithSegments(entry.segments, wanted))
  if (matches.length === 1) {
    return { ok: true, target: { kind: 'folder', folder: matches[0]!.folder } }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${trimmed}" matches ${matches.length} folders: ${candidateList(
        folders,
        matches.map((entry) => entry.folder)
      )}. Use the full path or the folder id.`
    }
  }
  return {
    ok: false,
    error:
      folders.length === 0
        ? `No folder matches "${trimmed}": there are no folders yet.`
        : `No folder matches "${trimmed}". Folders: ${candidateList(folders, folders)}.`
  }
}
