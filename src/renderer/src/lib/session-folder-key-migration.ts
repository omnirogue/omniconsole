import type { SidebarSession } from './sidebar-sessions'

/** The subset of the session-folders store this migration needs. */
export type SessionFolderKeyMigrationTarget = {
  migrateSessionKey: (fromKey: string, toKey: string) => boolean
}

/**
 * Apply every pending provisional-to-provider folder key migration carried on
 * `sessions` (see `SidebarSession.folderKeyMigration`). `target.migrateSessionKey`
 * is already idempotent, so calling this on every render is safe and cheap
 * once a pane has settled on its provider session.
 */
export function applySessionFolderKeyMigrations(
  sessions: readonly SidebarSession[],
  target: SessionFolderKeyMigrationTarget
): void {
  for (const session of sessions) {
    if (session.folderKeyMigration) {
      target.migrateSessionKey(session.folderKeyMigration.from, session.folderKeyMigration.to)
    }
  }
}
