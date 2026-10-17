import {
  deleteSessionFolder,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import { withValidParents } from '@/lib/session-folder-tree'
import type { Synced, SyncedFolders } from '../../../../shared/account-sync-session-docs'
import type { SyncedStampedValue } from './session-sync-stamps'
import { applySyncedProjects } from './session-sync-projects'
import {
  sameFolder,
  toLocalFolder,
  type LocalFolder,
  type LocalProjection,
  type LocalSyncInput
} from './session-sync-local'

/** Where a filing to `id` lands once deleted folders are followed, as deleting each one moves it. */
export function survivingFolder(folders: SyncedFolders, id: string | null): string | null {
  let current = id
  for (let hops = 0; current && folders[current]?.x && hops < 64; hops++) {
    const gone = folders[current]!
    current = gone.p ?? (gone.s === 'saved' ? SAVED_SESSIONS_FOLDER_ID : null)
  }
  return current
}

/** A folder's parent once deleted folders are followed: a deleted folder's subfolders move up. */
function survivingParent(folders: SyncedFolders, id: string | undefined): string | undefined {
  let current = id
  for (let hops = 0; current && folders[current]?.x && hops < 64; hops++) {
    current = folders[current]!.p
  }
  return current
}

const sameFolders = (left: readonly SessionFolder[], right: readonly SessionFolder[]) =>
  left.length === right.length &&
  left.every(
    (folder, index) =>
      folder.id === right[index]!.id &&
      sameFolder(toLocalFolder(folder), toLocalFolder(right[index]!))
  )

/** Every synced stamp read for a session, with its digest and what this computer holds now. */
export type SyncIncomingHook = (
  incoming: SyncedStampedValue & { digest: string; local: string | null | boolean }
) => void

/**
 * The folder metadata and archive changes that bring this computer in line with `merged`, for the
 * sessions it can name. A folder deleted anywhere is deleted here the way the app deletes one
 * (subfolders move up; its saved sessions stay saved), and so is a filing to it, whenever the
 * session shows up. A session this computer cannot name yet keeps its synced state until it does.
 * `onIncoming` hears every stamp first, even one whose value this computer already holds.
 */
export function applySynced(
  input: LocalSyncInput,
  projection: LocalProjection,
  merged: Synced,
  onIncoming?: SyncIncomingHook
): { metadata: SessionFolderMetadata | null; archive: string[]; unarchive: string[] } {
  let metadata = input.metadata
  for (const [id, remote] of Object.entries(merged.folders)) {
    if (remote.x && metadata.folders.some((folder) => folder.id === id)) {
      metadata = deleteSessionFolder(metadata, id)
    }
  }
  const upserted = new Map(metadata.folders.map((folder) => [folder.id, folder]))
  for (const [id, remote] of Object.entries(merged.folders)) {
    const parent = survivingParent(merged.folders, remote.p)
    const want: LocalFolder = {
      n: remote.n,
      ...(parent ? { p: parent } : {}),
      ...(remote.s ? { s: remote.s } : {})
    }
    const own = upserted.get(id)
    if (!remote.x && !sameFolder(own ? toLocalFolder(own) : undefined, want)) {
      upserted.set(id, {
        id,
        name: want.n,
        ...(want.p ? { parentId: want.p } : {}),
        ...(want.s ? { section: want.s } : {})
      })
    }
  }
  // Why: two computers can nest two folders in each other at once; keep the tree the store accepts.
  const folders = withValidParents([...upserted.values()])
  const ids = new Set(folders.map((folder) => folder.id))
  const live = (id: string) => id === SAVED_SESSIONS_FOLDER_ID || ids.has(id)
  const membership = { ...metadata.membership }
  const archived = new Set(input.archived)
  const shown = new Set(input.present)
  const archive: string[] = []
  const unarchive: string[] = []
  // Each key this computer holds the session under takes the account's state, one by one; an old
  // key it no longer shows is corrected or cleared but never given new state of its own.
  for (const [digest, local] of Object.entries(projection.sessions)) {
    const remote = merged.sessions[digest]
    const target = remote?.f ? survivingFolder(merged.folders, remote.f[0]) : undefined
    // Why before the equal-value skip below: X → Y → X elsewhere is a new stamp on the same folder.
    for (const key of onIncoming ? local.keys : []) {
      if (remote?.f) {
        const held = input.metadata.membership[key] ?? null
        const value = target ?? null
        onIncoming?.({ field: 'placement', digest, key, value, stamp: remote.f[1], local: held })
      }
      if (remote?.a) {
        const value = remote.a[0] !== null
        const held = archived.has(key)
        onIncoming?.({ field: 'archived', digest, key, value, stamp: remote.a[1], local: held })
      }
    }
    if (target !== undefined && (target === null || live(target))) {
      for (const key of local.keys) {
        const held = Object.hasOwn(membership, key)
        if ((held ? membership[key] : null) === target) {
          continue
        }
        if (target === null) {
          delete membership[key]
        } else if (held || shown.has(key)) {
          membership[key] = target
        }
      }
    }
    if (remote?.a) {
      const want = remote.a[0] !== null
      for (const key of local.keys) {
        if (archived.has(key) !== want && (!want || shown.has(key))) {
          ;(want ? archive : unarchive).push(key)
        }
      }
    }
  }
  const projects = applySyncedProjects(folders, metadata.projects, merged.projects ?? {})
  const changed =
    projects !== null ||
    !sameFolders(folders, input.metadata.folders) ||
    JSON.stringify(membership) !== JSON.stringify(input.metadata.membership)
  return {
    metadata: changed
      ? { ...metadata, folders, membership, ...(projects ? { projects } : {}) }
      : null,
    archive,
    unarchive
  }
}
