/**
 * The person's own organization changes from the sidebar and work surfaces, each one recorded
 * change through the change path (applied first, recorded after; a record failure only toasts).
 * Remote archives wait for the owning computer's recorded change before reporting success.
 */

import { useSessionFolders } from '@/store/session-folders'
import type {
  OrganizationChangeKind,
  OrganizationExecutor,
  OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  applyPersonOrganizationChange,
  recordPersonOrganizationChange,
  windowOrganizationStores,
  type OrganizationChangeDeps
} from './session-organization-change'
import type { ProjectSettings } from '../../../shared/project-settings'
import type { SessionFolderColor } from './session-folder-colors'
import type { SessionFolderSection } from './session-folder-tree'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import { sessionFolderGroupKey } from './session-sidebar-view'
import { archiveOnSessionOwner, hasRemoteSessionOwner } from './session-owner-archive'
import { isMirroredConversationLedgerKey } from './mirrored-sidebar-conversation'
import { movableSessionKeys } from './session-move-owner-guard'

export type PersonSurface = Extract<OrganizationExecutor, { kind: 'person' }>['via']
export type PersonChangeOptions = { via?: PersonSurface; deps?: OrganizationChangeDeps }

function applyByPerson(
  kind: OrganizationChangeKind,
  targets: OrganizationTarget[],
  value: unknown,
  options: PersonChangeOptions
): boolean {
  if (targets.length === 0) {
    return true
  }
  const { outcome } = applyPersonOrganizationChange(
    { kind, targets, value, executor: { kind: 'person', via: options.via ?? 'sidebar' } },
    options.deps
  )
  return outcome.status === 'applied' && !outcome.error
}

const sessionTargets = (keys: readonly string[]): OrganizationTarget[] =>
  [...new Set(keys.filter(Boolean))].map((sessionKey) => ({ sessionKey }))

/**
 * Files sessions in a folder (`saved-sessions` for the Saved root, null for unfiled). Rows a
 * paired owner places are refused with "Open it on <Computer>" and the rest still move; false
 * when nothing could.
 */
export function moveSessionsByPerson(
  keys: readonly string[],
  folderId: string | null,
  options: PersonChangeOptions = {}
): boolean {
  const movable = movableSessionKeys(keys)
  if (movable.length === 0 && keys.length > 0) {
    return false
  }
  return applyByPerson('move', sessionTargets(movable), folderId, options)
}

export async function archiveSessionsByPerson(
  keys: readonly string[],
  archived: boolean,
  options: PersonChangeOptions = {}
): Promise<boolean> {
  const unique = [...new Set(keys)]
  const remote = unique.filter(hasRemoteSessionOwner)
  const local = unique.filter((key) => !hasRemoteSessionOwner(key))
  const applied = applyByPerson(
    archived ? 'archive' : 'unarchive',
    sessionTargets(local),
    archived,
    options
  )
  const confirmed = await Promise.all(
    remote.map((key) => archiveOnSessionOwner(key, archived, options.deps?.rpc))
  )
  return applied && confirmed.every(Boolean)
}

/** Deletes rows from the list (or brings them back); tabs are closed by the caller. */
export function deleteSessionsByPerson(
  keys: readonly string[],
  deleted: boolean,
  options: PersonChangeOptions = {}
): boolean {
  // Why (session parity, step 7): a ledger row's conversation runs on its paired owner, so it is
  // deleted there; the callers refuse such rows, and an undo may still bring one back.
  const targets = deleted ? keys.filter((key) => !isMirroredConversationLedgerKey(key)) : keys
  return applyByPerson('delete', sessionTargets(targets), deleted, options)
}

/** Hides rows from the list (or shows them again); per device. */
export function hideSessionsByPerson(
  keys: readonly string[],
  hidden: boolean,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson(hidden ? 'hide' : 'unhide', sessionTargets(keys), hidden, options)
}

/**
 * Gives rows a tag (or takes it away). `automaticTag` is the tag a row shows with none chosen
 * (its company), so a first choice keeps it.
 */
export function tagSessionsByPerson(
  keys: readonly string[],
  tagId: string,
  tagged: boolean,
  options: PersonChangeOptions & { automaticTag?: (sessionKey: string) => string | null } = {}
): boolean {
  const { automaticTag, ...rest } = options
  const stores = rest.deps?.stores ?? windowOrganizationStores()
  return applyByPerson(tagged ? 'tag' : 'untag', sessionTargets(keys), tagId, {
    ...rest,
    deps: { ...rest.deps, stores: automaticTag ? { ...stores, automaticTag } : stores }
  })
}

/** Puts rows away until a time (epoch ms), or brings them back now with null. */
export function snoozeSessionsByPerson(
  keys: readonly string[],
  until: number | null,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('snooze', sessionTargets(keys), until, options)
}

export function moveFolderByPerson(
  folderId: string,
  parentId: string | null,
  section?: SessionFolderSection,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson(
    'folder.move',
    [{ folderId }],
    { parentId, ...(section ? { section } : {}) },
    options
  )
}

export function renameFolderByPerson(
  folderId: string,
  name: string,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('folder.rename', [{ folderId }], name.trim(), options)
}

/** A color for a folder group or the Saved root, keyed by its sidebar group key. */
export function colorFolderGroupByPerson(
  groupKey: string,
  color: SessionFolderColor | null,
  options: PersonChangeOptions = {}
): boolean {
  const prefix = sessionFolderGroupKey('')
  const folderId =
    groupKey === SAVED_SESSIONS_FOLDER_ID
      ? groupKey
      : groupKey.startsWith(prefix)
        ? groupKey.slice(prefix.length)
        : null
  if (!folderId) {
    return false
  }
  return applyByPerson('folder.color', [{ folderId }], color, options)
}

const foldersOf = (options: PersonChangeOptions) =>
  options.deps?.stores?.folders ?? useSessionFolders

function folderShape(folder: SessionFolder): Record<string, unknown> {
  return {
    name: folder.name,
    parentId: folder.parentId ?? null,
    section: folder.section === 'saved' ? 'saved' : 'active'
  }
}

/**
 * Creates a folder; its id, or null when the store refused (its error says why). With `project`,
 * the folder and its settings are one edit and one recorded `folder.create` carrying them.
 */
export function createFolderByPerson(
  name: string,
  section?: 'saved',
  parentId?: string,
  options: PersonChangeOptions & { project?: ProjectSettings } = {}
): string | null {
  const store = foldersOf(options)
  const id = store.getState().createFolder(name, section, parentId, options.project)
  const created = id
    ? store.getState().metadata.folders.find((folder) => folder.id === id)
    : undefined
  if (id && created) {
    const project = store.getState().metadata.projects?.[id]
    const shape = { ...folderShape(created), ...(project ? { project } : {}) }
    recordPersonOrganizationChange(
      {
        kind: 'folder.create',
        targets: [{ folderId: id }],
        value: shape,
        executor: { kind: 'person', via: options.via ?? 'sidebar' }
      },
      { before: [null], after: [shape] },
      options.deps
    )
  }
  return id
}

/**
 * Saves a project folder's settings, or removes them with null, as one recorded `folder.project`
 * change Undo can put back; false when the store refused (its error says why).
 */
export function setProjectSettingsByPerson(
  folderId: string,
  settings: ProjectSettings | null,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('folder.project', [{ folderId }], settings, options)
}

/** Deletes a folder (its sessions are kept); false when the store refused. */
export function deleteFolderByPerson(folderId: string, options: PersonChangeOptions = {}): boolean {
  const store = foldersOf(options)
  const folder = store.getState().metadata.folders.find((entry) => entry.id === folderId)
  if (!folder || !store.getState().deleteFolder(folderId)) {
    return false
  }
  recordPersonOrganizationChange(
    {
      kind: 'folder.delete',
      targets: [{ folderId }],
      value: true,
      executor: { kind: 'person', via: options.via ?? 'sidebar' }
    },
    { before: [folderShape(folder)], after: [null] },
    options.deps
  )
  return true
}
