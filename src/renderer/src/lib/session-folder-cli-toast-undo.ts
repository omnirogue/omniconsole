import {
  inverseOrganizationKind,
  type OrganizationChangeKind,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import { undoSessionFolderChange, type SessionFolderUndo } from './session-folder-cli-undo'
import type { SessionFolderCliStores } from './session-folder-cli-op-helpers'
import {
  recordPersonOrganizationChange,
  undoOrganizationChange,
  type OrganizationChangeDeps
} from './session-organization-change'

/** The recorded change a CLI op made, when main recorded it (an older main records none). */
export type RelayedChangeRef = {
  opId: string
  kind: OrganizationChangeKind
  targets: OrganizationTarget[]
}

// Why these: a folder created, deleted or reordered has no value to put back; its tree snapshot does.
const TREE_UNDO_KIND: Partial<Record<OrganizationChangeKind, OrganizationChangeKind>> = {
  'folder.create': 'folder.delete',
  'folder.delete': 'folder.create',
  'folder.reorder': 'folder.reorder'
}

function undoByTree(
  undo: SessionFolderUndo,
  change: RelayedChangeRef | null,
  stores: SessionFolderCliStores,
  deps: OrganizationChangeDeps
): boolean {
  if (!undoSessionFolderChange(undo, stores)) {
    return false
  }
  const kind = change && TREE_UNDO_KIND[change.kind]
  if (change && kind) {
    recordPersonOrganizationChange(
      {
        kind,
        targets: change.targets,
        value: null,
        executor: { kind: 'person', via: 'notice' },
        undoOf: change.opId
      },
      {},
      deps
    )
  }
  return true
}

/**
 * The Undo on a CLI change's toast: through main's record when the change has a value inverse
 * (targets changed since are left alone), else by the folder-tree snapshot. False: nothing undone.
 */
export async function undoRelayedFolderChange(
  undo: SessionFolderUndo,
  change: RelayedChangeRef | null,
  stores: SessionFolderCliStores,
  deps: OrganizationChangeDeps = {}
): Promise<boolean> {
  if (!change || !inverseOrganizationKind(change.kind)) {
    return undoByTree(undo, change, stores, deps)
  }
  const outcome = await undoOrganizationChange(change.opId, { ...deps, stores, via: 'notice' })
  if (outcome.error && outcome.total === 0) {
    // Why fall back: main could not plan it (no record), so the snapshot is all there is.
    return undoByTree(undo, null, stores, deps)
  }
  return outcome.undone > 0
}
