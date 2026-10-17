import type { SessionFolderOp } from './session-folder-cli'
import { SAVED_SESSIONS_REF_ID } from './session-folder-ref'
import type { OrganizationChangeKind, OrganizationTarget } from './session-organization-change'

/** The organization kind of one `omni folder …` / `omni session move|archive|delete` op. */
export function organizationKindForFolderOp(op: SessionFolderOp): OrganizationChangeKind {
  switch (op.kind) {
    case 'moveSession':
      return 'move'
    case 'archiveSession':
      return op.archived ? 'archive' : 'unarchive'
    case 'deleteSession':
      return 'delete'
    case 'createFolder':
      return 'folder.create'
    case 'renameFolder':
      return 'folder.rename'
    case 'moveFolder':
      return 'folder.move'
    case 'deleteFolder':
      return 'folder.delete'
    case 'colorFolder':
      return 'folder.color'
    case 'reorderFolder':
      return 'folder.reorder'
  }
}

/** What main knows of the targets before the window resolves them: a session's pane or tab. */
export function requestedTargetsForFolderOp(op: SessionFolderOp): OrganizationTarget[] {
  if (op.kind === 'moveSession' || op.kind === 'archiveSession' || op.kind === 'deleteSession') {
    return [
      {
        ...(op.paneKey ? { paneKey: op.paneKey } : {}),
        ...(op.tabId ? { tabId: op.tabId } : {}),
        // Why: an interrupted change is checked later; a pane-less workflow is found by its run.
        ...('workflow' in op && op.workflow ? { workflow: op.workflow } : {})
      }
    ]
  }
  return []
}

/** The value as requested; a folder is still the reference the caller named (id or path). */
export function requestedValueForFolderOp(op: SessionFolderOp): unknown {
  switch (op.kind) {
    case 'moveSession':
      return op.destination === 'folder'
        ? (op.folder ?? null)
        : op.destination === 'saved'
          ? SAVED_SESSIONS_REF_ID
          : null
    case 'archiveSession':
      return op.archived
    case 'deleteSession':
      return true
    case 'createFolder':
      return { name: op.name, parent: op.parent ?? null, saved: op.saved === true }
    case 'renameFolder':
      return op.name
    case 'moveFolder':
      return { into: op.into ?? null, section: op.section ?? null }
    case 'colorFolder':
      return op.color
    case 'reorderFolder':
      return { target: op.target, position: op.position }
    case 'deleteFolder':
      return null
  }
}
