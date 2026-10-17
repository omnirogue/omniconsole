import type { createSessionFoldersStore } from '@/store/session-folders'
import type { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { SessionFolderMutationResult } from '../../../shared/session-folder-cli'
import {
  resolveSessionFolderRef,
  SAVED_SESSIONS_LABEL,
  sessionFolderDisplayPath,
  type SessionFolderRefTarget
} from '../../../shared/session-folder-ref'
import type { SessionFolderUndo } from './session-folder-cli-undo'
import type { SessionFolder } from './session-folders'

export type SessionFolderCliStores = {
  folders: ReturnType<typeof createSessionFoldersStore>
  view: ReturnType<typeof createSessionSidebarViewStore>
}

/** The conversation a session op names, already found in the sidebar's session list. */
export type SessionFolderCliSession = { key: string; label: string; tabId?: string | null }

/** What one op changed, how to take it back beyond the folder state, and what to unfold. */
export type OpOutcome = {
  result: SessionFolderMutationResult
  undo: Omit<SessionFolderUndo, 'before' | 'after'>
  reveal: string[]
}

/** A refusal worded for the person; `applySessionFolderOp` turns it into `{ ok: false }`. */
export class OpError extends Error {}

export function fail(message: string): never {
  throw new OpError(message)
}

export function resolve(
  folders: readonly SessionFolder[],
  ref: string
): SessionFolderRefTarget<SessionFolder> {
  const resolved = resolveSessionFolderRef(folders, ref)
  return resolved.ok ? resolved.target : fail(resolved.error)
}

export function resolveFolder(folders: readonly SessionFolder[], ref: string): SessionFolder {
  const target = resolve(folders, ref)
  return target.kind === 'folder'
    ? target.folder
    : fail(
        `${SAVED_SESSIONS_LABEL} itself cannot be moved, renamed or deleted; name a folder inside it.`
      )
}

export function targetLabel(
  folders: readonly SessionFolder[],
  target: SessionFolderRefTarget<SessionFolder>
): string {
  return target.kind === 'folder'
    ? sessionFolderDisplayPath(folders, target.folder)
    : SAVED_SESSIONS_LABEL
}
