import type { SessionFolder, SessionFolderMetadata } from '@/lib/session-folders'
import { localKeyDigest, type FolderPaths } from '../../../../shared/account-sync-session-keys'
import type {
  Stamped,
  Synced,
  SyncedFolder,
  SyncedFolders,
  SyncedSession,
  SyncedSessions
} from '../../../../shared/account-sync-session-docs'
import type { SessionOrganizationIntent } from './session-organization-intent'
import type { ProjectSettings } from '../../../../shared/project-settings'
import { authorProjectEdits } from './session-sync-projects'

/** This computer's own view of one synced session: its folder and archive state, by local keys. */
export type LocalSession = { f: string | null; a: number | null; keys: string[] }
export type LocalFolder = { n: string; p?: string; s?: 'saved' }

export type LocalProjection = {
  sessions: Record<string, LocalSession>
  folders: Record<string, LocalFolder>
  projects?: Readonly<Record<string, ProjectSettings>>
}

export type LocalSyncInput = {
  metadata: SessionFolderMetadata
  archived: readonly string[]
  archivedAt: Readonly<Record<string, number>>
  /** Keys of the sessions shown on this computer now, so a remote change can find them. */
  present: readonly string[]
  /** This computer's folder workspaces by id, to their paths: a session's shared identity. */
  folderPaths: FolderPaths
}

export const toLocalFolder = (folder: SessionFolder): LocalFolder => ({
  n: folder.name,
  ...(folder.parentId ? { p: folder.parentId } : {}),
  ...(folder.section === 'saved' ? { s: 'saved' as const } : {})
})

/** The key among `keys` the person acted on last, in the journal's order. */
function lastNoted(keys: readonly string[], noted: ReadonlySet<string>): string | undefined {
  let last: string | undefined
  for (const key of noted) {
    if (keys.includes(key)) {
      last = key
    }
  }
  return last
}

/**
 * Folders, folder membership and archive state on this computer, by synced session name. A session
 * can sit under several keys here (an old repository or host id beside the current one); when the
 * person changed one of them, that key's state, even an absence, is the session's.
 */
export function projectLocal(
  input: LocalSyncInput,
  noted?: Pick<SessionOrganizationIntent, 'filed' | 'archived'>
): LocalProjection {
  const sessions: Record<string, LocalSession> = {}
  const entry = (key: string): LocalSession | null => {
    const digest = localKeyDigest(key, input.folderPaths)
    if (!digest) {
      return null
    }
    const session = (sessions[digest] ??= { f: null, a: null, keys: [] })
    if (!session.keys.includes(key)) {
      session.keys.push(key)
    }
    return session
  }
  for (const key of input.present) {
    entry(key)
  }
  for (const [key, folderId] of Object.entries(input.metadata.membership)) {
    const session = entry(key)
    if (session) {
      session.f = folderId
    }
  }
  const archived = new Set(input.archived)
  for (const key of archived) {
    const session = entry(key)
    if (session) {
      session.a = input.archivedAt[key] ?? 0
    }
  }
  for (const session of noted ? Object.values(sessions) : []) {
    const filedKey = lastNoted(session.keys, noted!.filed)
    if (filedKey !== undefined) {
      session.f = Object.hasOwn(input.metadata.membership, filedKey)
        ? input.metadata.membership[filedKey]!
        : null
    }
    const archivedKey = lastNoted(session.keys, noted!.archived)
    if (archivedKey !== undefined) {
      session.a = archived.has(archivedKey) ? (input.archivedAt[archivedKey] ?? 0) : null
    }
  }
  return {
    sessions,
    folders: Object.fromEntries(
      input.metadata.folders.map((folder) => [folder.id, toLocalFolder(folder)])
    ),
    projects: input.metadata.projects ?? {}
  }
}

export const sameFolder = (left: LocalFolder | undefined, right: LocalFolder | undefined) =>
  !!left && !!right && left.n === right.n && left.p === right.p && left.s === right.s

const sameFiling = (left: string | null, right: string | null) => left === right
const sameArchive = (left: number | null, right: number | null) =>
  (left === null) === (right === null)

/**
 * Whether this computer's value of one field is an edit to publish: the person's own change the
 * account does not hold yet, or a value the account lacks entirely (a first sync, a session filed
 * before it synced). Anything else this computer shows differently is the account's to set: lost
 * storage, a reload, or a change the sync applied and could not record before a failure.
 */
function isEdit<T>(field: {
  local: T | null
  known: Stamped<T | null> | undefined
  intended: boolean
  same: (left: T | null, right: T | null) => boolean
}): boolean {
  const { local, known, intended, same } = field
  return intended ? !same(known?.[0] ?? null, local) : local !== null && !known
}

const tombstone = (folder: LocalFolder, t: number): SyncedFolder => ({
  n: folder.n,
  ...(folder.p ? { p: folder.p } : {}),
  ...(folder.s ? { s: folder.s } : {}),
  t,
  x: 1
})

/** The changes this computer authors, each stamped by `stamp` (after anything seen). */
export function authorLocalEdits(input: {
  merged: Synced
  now: LocalProjection
  intent: SessionOrganizationIntent
  stamp: () => number
}): Synced {
  const { merged, now, intent, stamp } = input
  const sessions: SyncedSessions = {}
  for (const [digest, local] of Object.entries(now.sessions)) {
    const known = merged.sessions[digest]
    const edit: SyncedSession = {}
    const noted = (keys: Set<string>) => local.keys.some((key) => keys.has(key))
    const filed = isEdit({
      local: local.f,
      known: known?.f,
      intended: noted(intent.filed),
      same: sameFiling
    })
    if (filed) {
      edit.f = [local.f, stamp()]
    }
    const archived = isEdit({
      local: local.a,
      known: known?.a,
      intended: noted(intent.archived),
      same: sameArchive
    })
    if (archived) {
      edit.a = [local.a, stamp()]
    }
    if (edit.f || edit.a) {
      sessions[digest] = edit
    }
  }
  const folders: SyncedFolders = {}
  for (const [id, local] of Object.entries(now.folders)) {
    const known = merged.folders[id]
    const changed = intent.folders.has(id)
      ? !known || !!known.x || !sameFolder(known, local)
      : !known
    if (changed) {
      folders[id] = { ...local, t: stamp() }
    }
  }
  // Only a folder the person deleted is deleted everywhere, as it was when they deleted it.
  for (const id of intent.folders) {
    const known = merged.folders[id]
    if (!now.folders[id] && known && !known.x) {
      folders[id] = tombstone(intent.gone.get(id) ?? known, stamp())
    }
  }
  const projects = authorProjectEdits({
    merged: merged.projects ?? {},
    local: now.projects ?? {},
    noted: intent.projects ?? new Set(),
    stamp
  })
  return { sessions, folders, ...(Object.keys(projects).length ? { projects } : {}) }
}

/**
 * On a computer's first sync, its folders take the ids of synced folders with the same name, in
 * the same place, so the same folder made on two computers is one folder, not two.
 */
export function adoptSyncedFolderIds(
  metadata: SessionFolderMetadata,
  synced: SyncedFolders
): SessionFolderMetadata | null {
  const renamed = new Map<string, string>()
  const taken = new Set(metadata.folders.map((folder) => folder.id))
  const byDepth = [...metadata.folders].sort((left, right) => depth(left) - depth(right))
  function depth(folder: SessionFolder): number {
    let level = 0
    let parent = folder.parentId
    while (parent && level < 32) {
      parent = metadata.folders.find((entry) => entry.id === parent)?.parentId
      level += 1
    }
    return level
  }
  for (const folder of byDepth) {
    if (synced[folder.id]) {
      continue
    }
    const parent = folder.parentId ? (renamed.get(folder.parentId) ?? folder.parentId) : undefined
    const match = Object.entries(synced).find(
      ([id, remote]) =>
        !remote.x &&
        !taken.has(id) &&
        remote.n === folder.name &&
        remote.p === parent &&
        (remote.s ?? null) === (folder.section ?? null)
    )
    if (match) {
      renamed.set(folder.id, match[0])
      taken.add(match[0])
    }
  }
  if (!renamed.size) {
    return null
  }
  const rename = (id: string) => renamed.get(id) ?? id
  return {
    ...metadata,
    folders: metadata.folders.map((folder) => ({
      ...folder,
      id: rename(folder.id),
      ...(folder.parentId ? { parentId: rename(folder.parentId) } : {})
    })),
    membership: Object.fromEntries(
      Object.entries(metadata.membership).map(([key, id]) => [key, rename(id)])
    ),
    // A session set to be saved into a folder when it finishes keeps going to that folder.
    ...(metadata.finishActions
      ? {
          finishActions: Object.fromEntries(
            Object.entries(metadata.finishActions).map(([key, action]) => [
              key,
              action.folderId ? { ...action, folderId: rename(action.folderId) } : action
            ])
          )
        }
      : {})
  }
}
