import type {
  SessionFolderMutationResult,
  SessionFolderOp
} from '../../../shared/session-folder-cli'
import { SAVED_SESSIONS_LABEL, sessionFolderDisplayPath } from '../../../shared/session-folder-ref'
import { parseSessionFolderColor } from './session-folder-cli-apply'
import {
  fail,
  OpError,
  resolve,
  resolveFolder,
  targetLabel,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from './session-folder-cli-op-helpers'
import { moveSessionFolder } from './session-folder-tree'
import { sessionArchiveKind } from './session-manage-conversation-organization'
import {
  getSessionFolderId,
  moveSessionToFolder,
  reorderSessionFolder,
  SAVED_SESSIONS_FOLDER_ID,
  sessionFolderNameError,
  type SessionFolder,
  type SessionFolderMetadata
} from './session-folders'

const DRY = ' (dry run: nothing changed)'

function folderPlace(metadata: SessionFolderMetadata, folderId: string | null): string {
  if (!folderId) {
    return 'unfiled'
  }
  if (folderId === SAVED_SESSIONS_FOLDER_ID) {
    return `“${SAVED_SESSIONS_LABEL}”`
  }
  const folder = metadata.folders.find((entry) => entry.id === folderId)
  return folder ? `“${sessionFolderDisplayPath(metadata.folders, folder)}”` : 'unfiled'
}

function tryPure<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

function previewFolderMove(
  op: Extract<SessionFolderOp, { kind: 'moveFolder' }>,
  metadata: SessionFolderMetadata
): string {
  const { folders } = metadata
  const folder = resolveFolder(folders, op.folder)
  const into = op.into ? resolve(folders, op.into) : null
  const parentId = into?.kind === 'folder' ? into.folder.id : null
  const section = into?.kind === 'saved-root' ? 'saved' : into ? undefined : op.section
  const nameError = sessionFolderNameError(
    folders.filter((entry) => entry.id !== folder.id),
    folder.name,
    undefined,
    parentId
  )
  if (nameError) {
    fail(nameError)
  }
  const moved = tryPure(() => moveSessionFolder(metadata, folder.id, parentId, section))
  const after = moved.folders.find((entry) => entry.id === folder.id)!
  return `Would move folder “${sessionFolderDisplayPath(folders, folder)}” to “${sessionFolderDisplayPath(moved.folders, after)}”, with its subfolders and sessions`
}

function previewFolderDelete(folder: SessionFolder, metadata: SessionFolderMetadata): string {
  const sessions = Object.values(metadata.membership).filter((id) => id === folder.id).length
  const subfolders = metadata.folders.filter((entry) => entry.parentId === folder.id).length
  const parent = folder.parentId
    ? metadata.folders.find((entry) => entry.id === folder.parentId)
    : undefined
  const heir = parent
    ? `into “${sessionFolderDisplayPath(metadata.folders, parent)}”`
    : folder.section === 'saved'
      ? `into “${SAVED_SESSIONS_LABEL}”`
      : 'to unfiled (subfolders to the top of Conversations)'
  return `Would delete folder “${sessionFolderDisplayPath(metadata.folders, folder)}”: its ${sessions} session${sessions === 1 ? '' : 's'} and ${subfolders} subfolder${subfolders === 1 ? '' : 's'} move up ${heir}; no session is closed or deleted`
}

function previewSummary(
  op: SessionFolderOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null
): string {
  const { metadata } = stores.folders.getState()
  const { folders } = metadata
  const target = (): SessionFolderCliSession =>
    session ?? fail('That conversation is not in the sidebar.')
  switch (op.kind) {
    case 'createFolder': {
      const parent = op.parent ? resolve(folders, op.parent) : null
      const parentId = parent?.kind === 'folder' ? parent.folder.id : null
      const error = sessionFolderNameError(folders, op.name, undefined, parentId)
      return error ? fail(error) : `Would create folder “${op.name.trim()}”`
    }
    case 'moveFolder':
      return previewFolderMove(op, metadata)
    case 'reorderFolder': {
      const folder = resolveFolder(folders, op.folder)
      const ref = resolve(folders, op.target)
      const sibling =
        ref.kind === 'folder'
          ? ref.folder
          : fail(`${SAVED_SESSIONS_LABEL} is a section; name a folder.`)
      if (folder.id === sibling.id) {
        fail('A folder cannot go before or after itself.')
      }
      if (
        (folder.parentId ?? null) !== (sibling.parentId ?? null) ||
        (folder.section === 'saved') !== (sibling.section === 'saved')
      ) {
        fail(
          'Those folders are not in the same folder. Move it there first with --into (or --top), then order it.'
        )
      }
      if (folder.parentId || folder.section === 'saved') {
        tryPure(() => reorderSessionFolder(metadata, folder.id, sibling.id, op.position))
      }
      return `Would move folder “${folder.name}” ${op.position} “${sibling.name}”`
    }
    case 'deleteFolder':
      return previewFolderDelete(resolveFolder(folders, op.folder), metadata)
    case 'renameFolder': {
      const folder = resolveFolder(folders, op.folder)
      const error = sessionFolderNameError(folders, op.name, folder.id)
      return error ? fail(error) : `Would rename folder “${folder.name}” to “${op.name.trim()}”`
    }
    case 'colorFolder': {
      const color = parseSessionFolderColor(op.color)
      const name = targetLabel(folders, resolve(folders, op.folder))
      return color ? `Would color folder “${name}” ${color}` : `Would clear the color of “${name}”`
    }
    case 'moveSession': {
      const moving = target()
      const dest =
        op.destination === 'folder'
          ? resolve(folders, op.folder ?? '')
          : op.destination === 'saved'
            ? ({ kind: 'saved-root' } as const)
            : null
      const folderId = dest
        ? dest.kind === 'folder'
          ? dest.folder.id
          : SAVED_SESSIONS_FOLDER_ID
        : null
      tryPure(() => moveSessionToFolder(metadata, moving.key, folderId))
      return `Would move “${moving.label}” from ${folderPlace(metadata, getSessionFolderId(metadata, moving.key))} to ${folderPlace(metadata, folderId)}`
    }
    case 'archiveSession': {
      const moving = target()
      const view = stores.view.getState()
      const isArchived = view.archived.includes(moving.key)
      if (op.archived === isArchived) {
        fail(
          op.archived
            ? `“${moving.label}” is already archived.`
            : `“${moving.label}” is not archived, so there is nothing to unarchive.`
        )
      }
      const automatic = sessionArchiveKind(view.view, view.archived, moving.key) === 'automatic'
      return op.archived
        ? `Would archive “${moving.label}”; its folder is kept`
        : `Would unarchive “${moving.label}”${automatic ? ' (filed automatically after a verified finish)' : ''} and keep it visible; its folder is kept`
    }
    case 'deleteSession':
      return `Would delete “${target().label}”: its tab closes the way its own close does (history kept, reopenable from Recently closed) and the row leaves the list`
  }
}

/** What an op would change, checked as the real op checks it, with nothing written anywhere. */
export function previewSessionFolderOp(
  op: SessionFolderOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null
): { ok: true; result: SessionFolderMutationResult } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      result: { summary: `${previewSummary(op, stores, session)}${DRY}.`, dryRun: true }
    }
  } catch (error) {
    if (error instanceof OpError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}
