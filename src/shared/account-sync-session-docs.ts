import { z } from 'zod'
import { parseDeviceDocKey } from './account-sync-session-keys'
import { parseProjectSettings, type ProjectSettings } from './project-settings'

/** A value and when it was set (epoch ms). The later write wins; see `newer` for a tie. */
export type Stamped<T> = [T, number]

/** One session: the folder it is in (null: none) and when it was archived (null: not archived). */
export type SyncedSession = { f?: Stamped<string | null>; a?: Stamped<number | null> }

/** One folder: name, parent, section, when it last changed, and `x` once deleted. */
export type SyncedFolder = { n: string; p?: string; s?: 'saved'; t: number; x?: 1 }

/** One project folder's settings as a whole, when they last changed, and `x` once removed. */
export type SyncedProject = { v?: ProjectSettings; t: number; x?: 1 }

export type SyncedSessions = Record<string, SyncedSession>
export type SyncedFolders = Record<string, SyncedFolder>
export type SyncedProjects = Record<string, SyncedProject>

const DIGEST = /^[0-9a-f]{24}$/
const FOLDER_ID = /^[0-9a-f-]{36}$|^saved-sessions$/
// Why: a folder or parent id the folder store would refuse must never reach it from another computer.
const isFolderId = (id: unknown): id is string => z.string().uuid().safeParse(id).success

function stamped<T>(value: unknown, isValue: (item: unknown) => item is T): Stamped<T> | undefined {
  return Array.isArray(value) &&
    value.length === 2 &&
    isValue(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1]) &&
    value[1] >= 0
    ? [value[0], value[1]]
    : undefined
}

const isFolderRef = (item: unknown): item is string | null =>
  item === null || (typeof item === 'string' && FOLDER_ID.test(item))
const isArchivedAt = (item: unknown): item is number | null =>
  item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0)

/** A shard document as another computer wrote it: malformed entries are dropped, never trusted. */
export function parseSessionShard(value: unknown): SyncedSessions {
  const entries = (value as { v?: unknown; s?: unknown } | null)?.s
  if ((value as { v?: unknown } | null)?.v !== 1 || !entries || typeof entries !== 'object') {
    return {}
  }
  const sessions: SyncedSessions = {}
  for (const [digest, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (!DIGEST.test(digest) || !raw || typeof raw !== 'object') {
      continue
    }
    const f = stamped((raw as { f?: unknown }).f, isFolderRef)
    const a = stamped((raw as { a?: unknown }).a, isArchivedAt)
    if (f || a) {
      sessions[digest] = { ...(f ? { f } : {}), ...(a ? { a } : {}) }
    }
  }
  return sessions
}

export function parseFolderDoc(value: unknown): SyncedFolders {
  const entries = (value as { v?: unknown; f?: unknown } | null)?.f
  if ((value as { v?: unknown } | null)?.v !== 1 || !entries || typeof entries !== 'object') {
    return {}
  }
  const folders: SyncedFolders = {}
  for (const [id, raw] of Object.entries(entries as Record<string, unknown>)) {
    const folder = raw as Partial<SyncedFolder> | null
    if (
      !isFolderId(id) ||
      !folder ||
      typeof folder.n !== 'string' ||
      !folder.n.trim() ||
      folder.n.length > 80 ||
      typeof folder.t !== 'number' ||
      !Number.isFinite(folder.t) ||
      (folder.p !== undefined && !isFolderId(folder.p))
    ) {
      continue
    }
    folders[id] = {
      // Why: the folder store trims names; an untrimmed one would be rewritten on every pass.
      n: folder.n.trim(),
      t: folder.t,
      ...(folder.p ? { p: folder.p } : {}),
      ...(folder.s === 'saved' ? { s: 'saved' as const } : {}),
      ...(folder.x === 1 ? { x: 1 as const } : {})
    }
  }
  return folders
}

export function parseProjectDoc(value: unknown): SyncedProjects {
  const entries = (value as { v?: unknown; p?: unknown } | null)?.p
  if ((value as { v?: unknown } | null)?.v !== 1 || !entries || typeof entries !== 'object') {
    return {}
  }
  const projects: SyncedProjects = {}
  for (const [id, raw] of Object.entries(entries as Record<string, unknown>)) {
    const entry = raw as Partial<SyncedProject> | null
    if (!isFolderId(id) || typeof entry?.t !== 'number' || !Number.isFinite(entry.t)) {
      continue
    }
    if (entry.x === 1) {
      projects[id] = { t: entry.t, x: 1 }
      continue
    }
    // Why: settings a person never made (or this version cannot read) never reach the store.
    const settings = parseProjectSettings(entry.v)
    if (settings) {
      projects[id] = { v: settings, t: entry.t }
    }
  }
  return projects
}

/** Strictly newer: a later time; at the same time a value beats none, then the larger value. */
function newer<T>(left: Stamped<T>, right: Stamped<T>): boolean {
  if (left[1] !== right[1]) {
    return left[1] > right[1]
  }
  if ((left[0] === null) !== (right[0] === null)) {
    return right[0] === null
  }
  return JSON.stringify(left[0]) > JSON.stringify(right[0])
}

function later<T>(left: Stamped<T> | undefined, right: Stamped<T> | undefined) {
  if (!left || !right) {
    return left ?? right
  }
  return newer(right, left) ? right : left
}

/** Field by field, the later write wins, so two computers editing different things both keep theirs. */
export function mergeSessions(left: SyncedSessions, right: SyncedSessions): SyncedSessions {
  const merged: SyncedSessions = { ...left }
  for (const [digest, entry] of Object.entries(right)) {
    const own = merged[digest]
    const f = later(own?.f, entry.f)
    const a = later(own?.a, entry.a)
    merged[digest] = { ...(f ? { f } : {}), ...(a ? { a } : {}) }
  }
  return merged
}

export function mergeFolders(left: SyncedFolders, right: SyncedFolders): SyncedFolders {
  const merged: SyncedFolders = { ...left }
  for (const [id, folder] of Object.entries(right)) {
    const own = merged[id]
    merged[id] = own && !newer([folder, folder.t], [own, own.t]) ? own : folder
  }
  return merged
}

/** A project's settings travel whole: the later write wins, a removal included. */
export function mergeProjects(left: SyncedProjects, right: SyncedProjects): SyncedProjects {
  const merged: SyncedProjects = { ...left }
  for (const [id, project] of Object.entries(right)) {
    const own = merged[id]
    merged[id] = own && !newer([project, project.t], [own, own.t]) ? own : project
  }
  return merged
}

export function projectsAhead(ours: SyncedProjects, theirs: SyncedProjects): boolean {
  return Object.entries(ours).some(([id, project]) => {
    const other = theirs[id]
    return !other || newer([project, project.t], [other, other.t])
  })
}

/** True when `ours` has something `theirs` lacks or holds older: that document needs writing. */
export function sessionsAhead(ours: SyncedSessions, theirs: SyncedSessions): boolean {
  return Object.entries(ours).some(([digest, entry]) => {
    const other = theirs[digest]
    return (
      (entry.f !== undefined && (!other?.f || newer(entry.f, other.f))) ||
      (entry.a !== undefined && (!other?.a || newer(entry.a, other.a)))
    )
  })
}

export function foldersAhead(ours: SyncedFolders, theirs: SyncedFolders): boolean {
  return Object.entries(ours).some(([id, folder]) => {
    const other = theirs[id]
    return !other || newer([folder, folder.t], [other, other.t])
  })
}

/** `projects` is absent in state an older version saved. */
export type Synced = { sessions: SyncedSessions; folders: SyncedFolders; projects?: SyncedProjects }

export function mergeSynced(left: Synced, right: Synced): Synced {
  return {
    sessions: mergeSessions(left.sessions, right.sessions),
    folders: mergeFolders(left.folders, right.folders),
    projects: mergeProjects(left.projects ?? {}, right.projects ?? {})
  }
}

/** Every computer's documents merged, and each of this computer's own as omnios holds it. */
export function collectRemote(
  prefs: Record<string, unknown>,
  device: string
): { all: Synced; stored: Map<string, Synced> } {
  let all: Synced = { sessions: {}, folders: {} }
  const stored = new Map<string, Synced>()
  for (const [key, value] of Object.entries(prefs)) {
    const doc = parseDeviceDocKey(key)
    if (!doc) {
      continue
    }
    const part: Synced =
      doc.kind === 'folders'
        ? { sessions: {}, folders: parseFolderDoc(value) }
        : doc.kind === 'projects'
          ? { sessions: {}, folders: {}, projects: parseProjectDoc(value) }
          : { sessions: parseSessionShard(value), folders: {} }
    all = mergeSynced(all, part)
    if (doc.device === device) {
      stored.set(key, part)
    }
  }
  return { all, stored }
}

/** The newest stamp seen, so this computer's next edit is stamped after it whatever its clock. */
export function highestStamp(synced: Synced): number {
  let highest = 0
  for (const entry of Object.values(synced.sessions)) {
    highest = Math.max(highest, entry.f?.[1] ?? 0, entry.a?.[1] ?? 0)
  }
  for (const entry of [...Object.values(synced.folders), ...Object.values(synced.projects ?? {})]) {
    highest = Math.max(highest, entry.t)
  }
  return highest
}
