import {
  accountSyncValueSize,
  ACCOUNT_SYNC_VALUE_MAX_BYTES,
  type AccountSyncWriteArgs
} from '../../../../shared/account-sync-types'
import {
  foldersAhead,
  projectsAhead,
  sessionsAhead,
  type Synced,
  type SyncedFolders,
  type SyncedProjects,
  type SyncedSessions
} from '../../../../shared/account-sync-session-docs'
import {
  deviceDocKey,
  SESSION_SYNC_MAX_DOCS,
  syncDocIndex,
  type DeviceDocKind
} from '../../../../shared/account-sync-session-keys'

export const docValue = (kind: DeviceDocKind, part: Record<string, unknown>) =>
  kind === 'folders'
    ? { v: 1, f: part }
    : kind === 'projects'
      ? { v: 1, p: part }
      : { v: 1, s: part }

function split<T>(kind: DeviceDocKind, entries: Record<string, T>, count: number) {
  const parts = Array.from({ length: count }, () => ({}) as Record<string, T>)
  for (const [id, entry] of Object.entries(entries)) {
    parts[syncDocIndex(kind, id, count)]![id] = entry
  }
  return parts
}

/**
 * One kind of this computer's entries in the fewest documents that each fit omnios, never fewer
 * than before: doubling moves each entry to one of two documents, and every computer merges all.
 */
export function layout<T>(kind: DeviceDocKind, entries: Record<string, T>, from: number) {
  for (let count = from; ; count *= 2) {
    const parts = split(kind, entries, count)
    const fits = parts.every(
      (part) => accountSyncValueSize(docValue(kind, part)) <= ACCOUNT_SYNC_VALUE_MAX_BYTES
    )
    if (fits || count >= SESSION_SYNC_MAX_DOCS) {
      return { count, parts }
    }
  }
}

export type Planned = { adding: AccountSyncWriteArgs[]; dropping: AccountSyncWriteArgs[] }

/**
 * The documents to write: each one this computer holds newer entries for than omnios' copy of that
 * very document. When the documents doubled, a write that would drop an entry from its old
 * document before its new one holds it waits until every other write landed, so the account
 * never lacks it.
 */
export function plan(
  device: string,
  user: string,
  docs: {
    folders: { parts: SyncedFolders[] }
    sessions: { parts: SyncedSessions[] }
    projects?: { parts: SyncedProjects[] }
  },
  stored: Map<string, Synced>
): Planned {
  const planned: Planned = { adding: [], dropping: [] }
  function kind<T>(
    name: DeviceDocKind,
    parts: Record<string, T>[],
    ahead: (ours: Record<string, T>, theirs: Record<string, T>) => boolean
  ): void {
    const held = (index: number) =>
      (stored.get(deviceDocKey(device, name, index))?.[name] ?? {}) as Record<string, T>
    const landed = (id: string) => {
      const home = syncDocIndex(name, id, parts.length)
      const entry = parts[home]![id]
      return entry !== undefined && !ahead({ [id]: entry }, held(home))
    }
    parts.forEach((part, index) => {
      const mine = held(index)
      if (!ahead(part, mine)) {
        return
      }
      const write = {
        key: deviceDocKey(device, name, index),
        value: docValue(name, part),
        expectedUser: user
      }
      const safe = Object.keys(mine).every((id) => id in part || landed(id))
      ;(safe ? planned.adding : planned.dropping).push(write)
    })
  }
  kind('folders', docs.folders.parts, foldersAhead)
  kind('sessions', docs.sessions.parts, sessionsAhead)
  if (docs.projects) {
    kind('projects', docs.projects.parts, projectsAhead)
  }
  return planned
}
