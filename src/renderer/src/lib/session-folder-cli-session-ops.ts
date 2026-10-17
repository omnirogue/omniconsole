import { translate } from '@/i18n/i18n'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import {
  fail,
  type OpOutcome,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from './session-folder-cli-op-helpers'

type ArchiveSessionOp = Extract<SessionFolderOp, { kind: 'archiveSession' }>
type DeleteSessionOp = Extract<SessionFolderOp, { kind: 'deleteSession' }>

/**
 * The row's Archive / Unarchive button: the conversation moves under Archived (its folder is
 * kept). Unarchive takes back any archive, by hand or automatic, and keeps the row visible.
 */
export function applyArchiveSession(
  op: ArchiveSessionOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null
): OpOutcome {
  const target = session ?? fail('That conversation is not in the sidebar.')
  return applyArchiveSessionBatch(stores, [target], op.archived)[0]
}

/**
 * The list half of the sidebar's Delete: the row leaves the list (per device) until a tab for it
 * is open again. Closing its tab — history kept, reopenable from Recently closed — is the
 * caller's half, because it is asynchronous and needs the app's tabs.
 */
export function applyDeleteSession(
  _op: DeleteSessionOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null
): OpOutcome {
  const target = session ?? fail('That conversation is not in the sidebar.')
  stores.view.getState().setDeleted([target.key], true)
  return {
    result: {
      summary: translate('conversations.cliFolders.deletedSession', 'Deleted “{{session}}”', {
        session: target.label
      }),
      sessionKey: target.key
    },
    undo: { deleted: { key: target.key } },
    reveal: []
  }
}

export function applyArchiveSessionBatch(
  stores: SessionFolderCliStores,
  sessions: SessionFolderCliSession[],
  archived = true
): OpOutcome[] {
  const view = stores.view.getState()
  for (const session of sessions) {
    // Why one list: an automatic archive files its key here too (verifiedArchiveView).
    const isArchived = view.archived.includes(session.key)
    if (archived && isArchived) {
      fail(`“${session.label}” is already archived.`)
    }
    if (!archived && !isArchived) {
      fail(`“${session.label}” is not archived, so there is nothing to unarchive.`)
    }
  }
  // One store update prevents a later source refusal from leaving a partial archive. Without an
  // origin, unarchive records the keep-visible choice, as the row's own Unarchive does.
  view.setArchived(
    sessions.map((session) => session.key),
    archived
  )
  return sessions.map((session) => ({
    result: {
      summary: archived
        ? translate('conversations.cliFolders.archivedSession', 'Archived “{{session}}”', {
            session: session.label
          })
        : translate('conversations.cliFolders.unarchivedSession', 'Unarchived “{{session}}”', {
            session: session.label
          }),
      sessionKey: session.key
    },
    undo: { archived: { key: session.key, archived } },
    reveal: []
  }))
}
