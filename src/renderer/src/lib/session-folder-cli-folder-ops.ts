import { translate } from '@/i18n/i18n'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import { SAVED_SESSIONS_LABEL, sessionFolderDisplayPath } from '../../../shared/session-folder-ref'
import { sessionFolderEntry, sessionFolderRevealKeys } from './session-folder-cli-list'
import {
  fail,
  resolve,
  resolveFolder,
  type OpOutcome,
  type SessionFolderCliStores
} from './session-folder-cli-op-helpers'
import type { SessionFolderUndo } from './session-folder-cli-undo'
import { reorderSessionFolder, type SessionFolder } from './session-folders'
import { SESSION_OTHER_GROUP_KEY } from './session-sidebar-tree'
import { orderSessionGroupKeys, sessionFolderGroupKey } from './session-sidebar-view'

type ReorderFolderOp = Extract<SessionFolderOp, { kind: 'reorderFolder' }>
type DeleteFolderOp = Extract<SessionFolderOp, { kind: 'deleteFolder' }>

function isTopLevelActive(folder: SessionFolder): boolean {
  return !folder.parentId && folder.section !== 'saved'
}

/**
 * Top-level Conversations folders are ordered the way the sidebar's drag-and-drop orders them:
 * a group move in the per-device view. Returns how to move the folder back beside its old
 * neighbor.
 */
function moveTopLevelGroup(
  stores: SessionFolderCliStores,
  folders: readonly SessionFolder[],
  folder: SessionFolder,
  target: SessionFolder,
  position: 'before' | 'after'
): NonNullable<SessionFolderUndo['order']> {
  const view = stores.view.getState()
  // Why: the drop resolves against what the tree lists — top-level folders, the Active group and
  // anything already placed — so a folder never placed by hand keeps its drawn slot.
  const visibleKeys = [
    ...new Set([
      ...folders.filter(isTopLevelActive).map((entry) => sessionFolderGroupKey(entry.id)),
      SESSION_OTHER_GROUP_KEY,
      ...view.view.order
    ])
  ]
  const key = sessionFolderGroupKey(folder.id)
  const sequence = orderSessionGroupKeys(visibleKeys, view.view.order)
  const index = sequence.indexOf(key)
  const move =
    index > 0
      ? { key, target: sequence[index - 1]!, position: 'after' as const }
      : { key, target: sequence[1]!, position: 'before' as const }
  view.moveGroup({ key, target: sessionFolderGroupKey(target.id), position, visibleKeys })
  return { move, visibleKeys, after: stores.view.getState().view.order }
}

export function applyReorderFolder(
  op: ReorderFolderOp,
  stores: SessionFolderCliStores,
  storeError: (fallback: string) => string
): OpOutcome {
  const store = stores.folders.getState()
  const { folders } = store.metadata
  const folder = resolveFolder(folders, op.folder)
  const targetRef = resolve(folders, op.target)
  const target =
    targetRef.kind === 'folder'
      ? targetRef.folder
      : fail(`${SAVED_SESSIONS_LABEL} is a section, not a folder to sit beside; name a folder.`)
  const path = (entry: SessionFolder): string => sessionFolderDisplayPath(folders, entry)
  if (folder.id === target.id) {
    fail(`A folder cannot go before or after itself.`)
  }
  if (
    (folder.parentId ?? null) !== (target.parentId ?? null) ||
    (folder.section === 'saved') !== (target.section === 'saved')
  ) {
    fail(
      `“${path(folder)}” and “${path(target)}” are not in the same folder. Move it there first with --into (or --top), then order it.`
    )
  }
  const undo: OpOutcome['undo'] = {}
  if (isTopLevelActive(folder)) {
    undo.order = moveTopLevelGroup(stores, folders, folder, target, op.position)
  } else {
    let reordered: ReturnType<typeof reorderSessionFolder>
    try {
      reordered = reorderSessionFolder(store.metadata, folder.id, target.id, op.position)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not reorder the folder.')
    }
    if (!store.replaceMetadata(reordered)) {
      fail(storeError('Could not reorder the folder.'))
    }
  }
  const metadata = stores.folders.getState().metadata
  const values = { name: folder.name, target: path(target) }
  return {
    result: {
      summary:
        op.position === 'before'
          ? translate(
              'conversations.cliFolders.movedFolderBefore',
              'Moved folder “{{name}}” before “{{target}}”',
              values
            )
          : translate(
              'conversations.cliFolders.movedFolderAfter',
              'Moved folder “{{name}}” after “{{target}}”',
              values
            ),
      folder: sessionFolderEntry(metadata, stores.view.getState().view, folder)
    },
    undo,
    reveal: sessionFolderRevealKeys(metadata, folder.parentId ?? null, folder.section === 'saved')
  }
}

/**
 * The sidebar's "Delete folder": the folder goes, its subfolders move up to its parent, and its
 * sessions move up too — into the parent, into Saved Sessions for a top-level saved folder, or
 * back to unfiled for a top-level Conversations folder. No session is closed or deleted.
 */
export function applyDeleteFolder(
  op: DeleteFolderOp,
  stores: SessionFolderCliStores,
  storeError: (fallback: string) => string
): OpOutcome {
  const store = stores.folders.getState()
  const { metadata } = store
  const folder = resolveFolder(metadata.folders, op.folder)
  const deleted = sessionFolderEntry(metadata, stores.view.getState().view, folder)
  const parent = folder.parentId
    ? metadata.folders.find((entry) => entry.id === folder.parentId)
    : undefined
  const saved = folder.section === 'saved'
  if (!store.deleteFolder(folder.id)) {
    fail(storeError('Could not delete the folder.'))
  }
  const summary = parent
    ? translate(
        'conversations.cliFolders.deletedFolderIntoParent',
        'Deleted folder “{{path}}”. Its sessions and subfolders moved up into “{{parent}}”.',
        { path: deleted.path, parent: sessionFolderDisplayPath(metadata.folders, parent) }
      )
    : saved
      ? translate(
          'conversations.cliFolders.deletedFolderIntoSaved',
          'Deleted folder “{{path}}”. Its sessions and subfolders moved up into Saved Sessions.',
          { path: deleted.path }
        )
      : translate(
          'conversations.cliFolders.deletedFolderToTop',
          'Deleted folder “{{path}}”. Its sessions are unfiled now, and its subfolders moved to the top of Conversations.',
          { path: deleted.path }
        )
  return {
    result: { summary, folder: deleted },
    undo: {},
    reveal: sessionFolderRevealKeys(stores.folders.getState().metadata, parent?.id ?? null, saved)
  }
}
