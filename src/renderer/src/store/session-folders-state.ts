import type { SessionFinishAction, SessionFolderMetadata } from '@/lib/session-folders'
import type { SessionFolderSection } from '@/lib/session-folder-tree'
import type { ProjectSettings } from '../../../shared/project-settings'

export type SessionFoldersState = {
  metadata: SessionFolderMetadata
  loaded: boolean
  error: string | null
  load: () => void
  /**
   * `parentId` nests the new folder inside another of the same section; `project` saves it as a
   * project in the same edit (refused unless the folder can be one).
   */
  createFolder: (
    name: string,
    section?: 'saved',
    parentId?: string,
    project?: ProjectSettings
  ) => string | null
  /**
   * Moves a folder inside another (or to the top of `section`, its own by default, with null),
   * keeping its sessions and subfolders. A move across sections takes the whole branch along.
   */
  moveFolder: (id: string, parentId: string | null, section?: SessionFolderSection) => boolean
  saveSession: (sessionKey: string, folderId: string) => boolean
  setFinishAction: (sessionKey: string, action: SessionFinishAction) => boolean
  clearFinishAction: (sessionKey: string) => boolean
  /** Notes that an agent launched this session (Agent sessions); idempotent. */
  markAgentSession: (sessionKey: string) => boolean
  /** A person filed these sessions: they are theirs now, not agent sessions. */
  forgetAgentSessions: (sessionKeys: readonly string[]) => boolean
  finishForMe: (sessionKey: string, action: SessionFinishAction) => boolean
  renameFolder: (id: string, name: string) => boolean
  deleteFolder: (id: string) => boolean
  moveSession: (sessionKey: string, folderId: string | null) => boolean
  moveSessionDurably: (sessionKey: string, folderId: string | null, operationId: string) => boolean
  readTransferReceipt: (
    operationId: string
  ) => NonNullable<SessionFolderMetadata['transferReceipts']>[string] | null
  /** One save for a whole selection; all-or-nothing, so a bad key moves nobody. */
  moveSessions: (sessionKeys: readonly string[], folderId: string | null) => boolean
  /** Silent, idempotent: no-ops once `fromKey` has already been folded away. */
  migrateSessionKey: (fromKey: string, toKey: string) => boolean
  /** One save: `fromKey` folded onto `toKey`, the person's own choice for the pane winning. */
  claimSessionKey: (fromKey: string, toKey: string, folderId: string | null) => boolean
  /** Puts back a whole earlier state (an undo); refused when it no longer parses. */
  replaceMetadata: (metadata: SessionFolderMetadata) => boolean
  /**
   * A project folder's settings (null removes them); false with `error` set when invalid. Only the
   * change path calls it (`setProjectSettingsByPerson`).
   */
  setProjectSettings: (folderId: string, settings: ProjectSettings | null) => boolean
}
