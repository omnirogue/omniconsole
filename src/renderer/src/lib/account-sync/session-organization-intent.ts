import { personalViewStorageKey } from '@/lib/personal-view-storage'
import type { SessionFolder, SessionFolderMetadata } from '@/lib/session-folders'
import { isProvisionalSessionKey } from '../../../../shared/account-sync-session-keys'
import { changedProjectIds } from './session-sync-projects'

/** A deleted folder as it was when the person deleted it: where its sessions went. */
export type DeletedFolder = { n: string; p?: string; s?: 'saved' }

/**
 * What the person did to sessions' organization that has not reached the account yet: sessions
 * filed or unfiled, archived or unarchived, folders made, changed, deleted or put back. Only
 * these change what the account holds; anything else this computer shows differently (lost
 * storage, a reload, a change the sync applied) is set back to the account's. Changes the sync
 * applies are never noted. Kept in storage per account, so an edit made offline still counts
 * after a restart.
 */
export type SessionOrganizationIntent = {
  filed: Set<string>
  archived: Set<string>
  folders: Set<string>
  gone: Map<string, DeletedFolder>
  /** Project folders whose settings the person set, changed or removed; absent in older callers. */
  projects?: Set<string>
}

type Journal = { f?: unknown; a?: unknown; d?: unknown; g?: unknown; p?: unknown }

const STORAGE_KEY = 'omni.account-sync.intent'
/** Panes not yet named by their provider session wait here; past this many, the oldest go. */
const MAX_WAITING_PANES = 1_000
const held = new Map<string, SessionOrganizationIntent>()

/** The scope session folders, the list's view and their sync state belong to. */
export const sessionOrganizationScope = (): string => personalViewStorageKey('sessions')

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []

const snapshot = (folder: Pick<SessionFolder, 'name' | 'parentId' | 'section'>): DeletedFolder => ({
  n: folder.name,
  ...(folder.parentId ? { p: folder.parentId } : {}),
  ...(folder.section === 'saved' ? { s: 'saved' as const } : {})
})

const sameFolder = (left: SessionFolder | undefined, right: SessionFolder | undefined) =>
  left === right ||
  (!!left &&
    !!right &&
    left.name === right.name &&
    (left.parentId ?? null) === (right.parentId ?? null) &&
    (left.section ?? null) === (right.section ?? null))

function deletedFolders(value: unknown): Map<string, DeletedFolder> {
  const gone = new Map<string, DeletedFolder>()
  for (const [id, raw] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    const folder = raw as Partial<DeletedFolder> | null
    if (folder && typeof folder.n === 'string' && (!folder.p || typeof folder.p === 'string')) {
      gone.set(id, snapshot({ name: folder.n, parentId: folder.p, section: folder.s }))
    }
  }
  return gone
}

function journal(scope: string): SessionOrganizationIntent {
  let intent = held.get(scope)
  if (!intent) {
    let saved: Journal | null = null
    try {
      saved = JSON.parse(storage()?.getItem(`${STORAGE_KEY}:${scope}`) ?? 'null') as Journal | null
    } catch {
      // A damaged journal is dropped; its edits then count as unintended and the account restores them.
    }
    intent = {
      filed: new Set(strings(saved?.f)),
      archived: new Set(strings(saved?.a)),
      folders: new Set(strings(saved?.d)),
      gone: deletedFolders(saved?.g),
      projects: new Set(strings(saved?.p))
    }
    held.set(scope, intent)
  }
  return intent
}

function persist(scope: string, intent: SessionOrganizationIntent): void {
  const key = `${STORAGE_KEY}:${scope}`
  // Why: every other key settles at the next pass, so only a pane that never learns its
  // provider session could pile up; nothing the person did to a named session is dropped.
  for (const noted of [intent.filed, intent.archived]) {
    const panes = [...noted].filter(isProvisionalSessionKey)
    for (const oldest of panes.slice(0, Math.max(0, panes.length - MAX_WAITING_PANES))) {
      noted.delete(oldest)
    }
  }
  try {
    if (
      intent.filed.size +
        intent.archived.size +
        intent.folders.size +
        (intent.projects?.size ?? 0) ===
      0
    ) {
      storage()?.removeItem(key)
    } else {
      storage()?.setItem(
        key,
        JSON.stringify({
          f: [...intent.filed],
          a: [...intent.archived],
          d: [...intent.folders],
          g: Object.fromEntries(intent.gone),
          p: [...(intent.projects ?? [])]
        })
      )
    }
  } catch {
    // Kept in memory for this run.
  }
}

function edit(change: (intent: SessionOrganizationIntent) => void): void {
  const scope = sessionOrganizationScope()
  const intent = journal(scope)
  change(intent)
  persist(scope, intent)
}

/**
 * Notes everything one of the person's folder actions changed: each session whose folder it set,
 * and each folder it made, changed, deleted or put back (a deleted one as it was).
 */
export function noteSessionFolderEdit(
  before: SessionFolderMetadata,
  after: SessionFolderMetadata
): void {
  const keys = new Set([...Object.keys(before.membership), ...Object.keys(after.membership)])
  const filed = [...keys].filter((key) => before.membership[key] !== after.membership[key])
  const was = new Map(before.folders.map((folder) => [folder.id, folder]))
  const is = new Map(after.folders.map((folder) => [folder.id, folder]))
  const folders = [...new Set([...was.keys(), ...is.keys()])].filter(
    (id) => !sameFolder(was.get(id), is.get(id))
  )
  const projects = changedProjectIds(before.projects, after.projects)
  if (filed.length === 0 && folders.length === 0 && projects.length === 0) {
    return
  }
  edit((intent) => {
    for (const id of projects) {
      ;(intent.projects ??= new Set()).add(id)
    }
    for (const key of filed) {
      intent.filed.add(key)
    }
    for (const id of folders) {
      intent.folders.add(id)
      const gone = was.get(id)
      if (gone && !is.has(id)) {
        intent.gone.set(id, snapshot(gone))
      } else {
        intent.gone.delete(id)
      }
    }
  })
}

/** Sessions the person archived or unarchived. */
export function noteSessionsArchived(keys: readonly string[]): void {
  if (keys.length > 0) {
    edit((intent) => keys.forEach((key) => intent.archived.add(key)))
  }
}

export const hasNotedSessionChange = (field: 'filed' | 'archived', key: string) =>
  journal(sessionOrganizationScope())[field].has(key)

/** A session's key changed (a pane learned its provider session): its pending change follows it. */
export function renameNotedSessionKey(field: 'filed' | 'archived', from: string, to: string): void {
  if (from !== to && hasNotedSessionChange(field, from)) {
    edit((intent) => {
      intent[field].delete(from)
      intent[field].add(to)
    })
  }
}

/** What is pending for `scope`, as a copy; settle what the sync has recorded. */
export function pendingSessionOrganizationIntent(scope: string): SessionOrganizationIntent {
  const intent = journal(scope)
  return {
    filed: new Set(intent.filed),
    archived: new Set(intent.archived),
    folders: new Set(intent.folders),
    gone: new Map(intent.gone),
    ...(intent.projects?.size ? { projects: new Set(intent.projects) } : {})
  }
}

export function settleSessionOrganizationIntent(
  scope: string,
  done: SessionOrganizationIntent
): void {
  const intent = journal(scope)
  for (const field of ['filed', 'archived', 'folders', 'projects'] as const) {
    for (const id of done[field] ?? []) {
      intent[field]?.delete(id)
    }
  }
  for (const id of done.folders) {
    intent.gone.delete(id)
  }
  persist(scope, intent)
}
