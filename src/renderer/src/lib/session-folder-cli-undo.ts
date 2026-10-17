import type { createSessionFoldersStore } from '@/store/session-folders'
import { noteSessionFolderEdit } from './account-sync/session-organization-intent'
import type { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { isSessionFolderColor } from './session-folder-colors'
import { withValidParents } from './session-folder-tree'
import {
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder,
  type SessionFolderMetadata
} from './session-folders'

/** What one CLI-driven change touched, so it can be put back. */
export type SessionFolderUndo = {
  before: SessionFolderMetadata
  after: SessionFolderMetadata
  /** A group color the change set, keyed by sidebar group key. */
  color?: { key: string; before: string | null; after: string | null }
  /**
   * A Conversations group reorder (per device, like colors): the move that puts the group back
   * beside its old neighbor, applied only while the order is still the one the change saved.
   */
  order?: {
    move: { key: string; target: string; position: 'before' | 'after' }
    visibleKeys: readonly string[]
    after: readonly string[]
  }
  /** A conversation archived or unarchived by hand, by view key. */
  archived?: { key: string; archived: boolean }
  /** A conversation deleted from the list, by view key. */
  deleted?: { key: string }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** Puts back the per-device view changes, each only while it still holds. */
function undoViewChange(
  undo: SessionFolderUndo,
  view: ReturnType<ReturnType<typeof createSessionSidebarViewStore>['getState']>
): boolean {
  if (undo.order && sameKeys(view.view.order, undo.order.after)) {
    view.moveGroup({ ...undo.order.move, visibleKeys: undo.order.visibleKeys })
    return true
  }
  if (undo.archived && view.archived.includes(undo.archived.key) === undo.archived.archived) {
    view.setArchived([undo.archived.key], !undo.archived.archived)
    return true
  }
  if (undo.deleted && (view.view.deleted ?? []).includes(undo.deleted.key)) {
    view.setDeleted([undo.deleted.key], false)
    return true
  }
  return false
}

function sameFolder(left: SessionFolder | undefined, right: SessionFolder | undefined): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.name === right.name &&
    (left.section ?? null) === (right.section ?? null) &&
    (left.parentId ?? null) === (right.parentId ?? null)
  )
}

function hasSiblingNameClash(folders: readonly SessionFolder[]): boolean {
  const seen = new Set<string>()
  for (const folder of folders) {
    const key = JSON.stringify([folder.parentId ?? null, folder.name.toLowerCase()])
    if (seen.has(key)) {
      return true
    }
    seen.add(key)
  }
  return false
}

/**
 * The folder state with one change taken back. When nothing else changed since, that is simply
 * `before`. Otherwise only the folders and memberships the change touched are put back over
 * `current`, keeping everything done since; null when that would leave a broken tree (a folder
 * or session pointing at a folder that is gone, a loop, or two siblings with one name).
 */
export function revertSessionFolderChange(
  current: SessionFolderMetadata,
  before: SessionFolderMetadata,
  after: SessionFolderMetadata
): SessionFolderMetadata | null {
  if (current === after) {
    return before
  }
  const beforeById = new Map(before.folders.map((folder) => [folder.id, folder]))
  const afterById = new Map(after.folders.map((folder) => [folder.id, folder]))
  // Why: a reorder changes only where folders sit in the list; over later changes there is no
  // field to put back, so it is refused rather than reported as undone.
  const idOrder = (metadata: SessionFolderMetadata): string =>
    JSON.stringify(metadata.folders.map((folder) => folder.id))
  if (
    idOrder(before) !== idOrder(after) &&
    before.folders.length === after.folders.length &&
    before.folders.every((folder) => sameFolder(folder, afterById.get(folder.id))) &&
    JSON.stringify(before.membership) === JSON.stringify(after.membership)
  ) {
    return null
  }
  const folders = [...current.folders]
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const previous = beforeById.get(id)
    if (sameFolder(previous, afterById.get(id))) {
      continue
    }
    const index = folders.findIndex((folder) => folder.id === id)
    if (previous && index !== -1) {
      folders[index] = previous
    } else if (previous) {
      folders.push(previous)
    } else if (index !== -1) {
      folders.splice(index, 1)
    }
  }
  const membership = new Map(Object.entries(current.membership))
  const beforeMembership = new Map(Object.entries(before.membership))
  const afterMembership = new Map(Object.entries(after.membership))
  for (const key of new Set([...beforeMembership.keys(), ...afterMembership.keys()])) {
    const previous = beforeMembership.get(key)
    if (previous === afterMembership.get(key)) {
      continue
    }
    if (previous === undefined) {
      membership.delete(key)
    } else {
      membership.set(key, previous)
    }
  }
  const ids = new Set(folders.map((folder) => folder.id))
  const brokenParent = folders.some((folder) => folder.parentId && !ids.has(folder.parentId))
  const brokenMember = [...membership.values()].some(
    (folderId) => folderId !== SAVED_SESSIONS_FOLDER_ID && !ids.has(folderId)
  )
  const loop = withValidParents(folders).some((folder, index) => folder !== folders[index])
  if (brokenParent || brokenMember || loop || hasSiblingNameClash(folders)) {
    return null
  }
  // Why: fromEntries defines own data properties, so a "__proto__" session key stays data.
  return { ...current, folders, membership: Object.fromEntries(membership) }
}

/**
 * Takes one change back in the stores: the folder state via `revertSessionFolderChange`, and a
 * color only while it is still the one the change set. False when nothing could be put back.
 */
export function undoSessionFolderChange(
  undo: SessionFolderUndo,
  stores: {
    folders: ReturnType<typeof createSessionFoldersStore>
    view: ReturnType<typeof createSessionSidebarViewStore>
  }
): boolean {
  let undone = false
  if (undo.before !== undo.after) {
    const current = stores.folders.getState().metadata
    const reverted = revertSessionFolderChange(current, undo.before, undo.after)
    if (!reverted || !stores.folders.getState().replaceMetadata(reverted)) {
      return false
    }
    // What the undo put back is the person's own change, for their other computers too.
    noteSessionFolderEdit(current, stores.folders.getState().metadata)
    undone = true
  }
  if (undoViewChange(undo, stores.view.getState())) {
    undone = true
  }
  if (undo.color) {
    const view = stores.view.getState()
    if ((view.view.colors?.[undo.color.key] ?? null) !== undo.color.after) {
      return undone
    }
    const previous = undo.color.before
    view.setGroupColor(undo.color.key, isSessionFolderColor(previous) ? previous : null)
    undone = true
  }
  return undone
}
