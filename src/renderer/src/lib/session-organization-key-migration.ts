import {
  hasNotedSessionChange,
  renameNotedSessionKey
} from '@/lib/account-sync/session-organization-intent'
import { applySessionFolderKeyMigrations } from '@/lib/session-folder-key-migration'
import { getSessionFolderId } from '@/lib/session-folders'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { createSessionBatchOriginsStore } from '@/store/session-batch-origins'
import type { createSessionFoldersStore } from '@/store/session-folders'
import type { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { OwnershipKeyMove } from '../../../shared/session-organization-ownership'

/**
 * Folds each pane's folder and archive state onto its provider key once its provider session is
 * known. A filing or archiving the person made on the pane while it waited is theirs to keep over
 * whatever the provider key held from before, and its pending sync follows it. Ownership and
 * history follow the placement the provider key keeps, once that save has landed.
 */
export function migrateSessionOrganizationKeys(
  sessions: readonly SidebarSession[],
  stores: {
    folders: ReturnType<typeof createSessionFoldersStore>
    view: ReturnType<typeof createSessionSidebarViewStore>
    /** Absent where the tree keeps no launch origins. */
    origins?: ReturnType<typeof createSessionBatchOriginsStore>
    /** Absent where nothing keeps ownership (session-organization-ownership). */
    ownership?: { migrate: (moves: readonly OwnershipKeyMove[]) => void }
  }
): void {
  const moves = sessions.flatMap((session) =>
    session.folderKeyMigration ? [session.folderKeyMigration] : []
  )
  if (moves.length === 0) {
    return
  }
  const metadata = stores.folders.getState().metadata
  const filed = metadata.membership
  const archived = stores.view.getState().archived
  // Whether the provider key ends up with the pane's folder (as the folder store decides it).
  const placementFrom = new Map(
    moves.map(({ from, to }) => [
      from,
      getSessionFolderId(metadata, from) !== null && getSessionFolderId(metadata, to) === null
    ])
  )
  // A pane the person filed or unfiled moves in one save that keeps their choice; its pending
  // sync follows only once that save lands, and a failed one is retried with the next update.
  const claimed = new Set<string>()
  for (const { from, to } of moves) {
    if (hasNotedSessionChange('filed', from)) {
      claimed.add(from)
      const chosen = Object.hasOwn(filed, from) ? filed[from]! : null
      if (stores.folders.getState().claimSessionKey(from, to, chosen)) {
        renameNotedSessionKey('filed', from, to)
        placementFrom.set(from, true)
      }
    }
  }
  applySessionFolderKeyMigrations(
    sessions.filter((session) => !claimed.has(session.folderKeyMigration?.from ?? '')),
    stores.folders.getState()
  )
  for (const { from, to } of moves) {
    stores.origins?.getState().migrateSessionKey(from, to)
    stores.view.getState().migrateSessionKey(from, to)
    if (hasNotedSessionChange('archived', from)) {
      const chosen = archived.includes(from)
      const view = stores.view.getState()
      if (view.archived.includes(to) !== chosen) {
        view.setArchived([to], chosen)
      }
    }
    renameNotedSessionKey('archived', from, to)
  }
  // Why only landed moves: a pane still filed under its own key keeps its ownership until it moves.
  const landed = stores.folders.getState().metadata.membership
  stores.ownership?.migrate(
    moves
      .filter(({ from }) => !Object.hasOwn(landed, from))
      .map(({ from, to }) => ({ from, to, placementFrom: placementFrom.get(from) === true }))
  )
}
