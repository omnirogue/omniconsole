import { conversationViewKey } from './conversation-view'
import { isSessionSaved, type SessionFolderMetadata } from './session-folders'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import type { SidebarSession } from './sidebar-sessions'

/**
 * Why (Sal, 2026-10-19): "agent sessions [are] separate from human sessions and human started
 * sessions stay open until we close them." This computer's note that an agent launched a session
 * (`agentSessions`); saving it makes it the person's own.
 */
export function isAgentLaunchedSession(
  metadata: SessionFolderMetadata,
  sessionKey: string
): boolean {
  return (
    Object.hasOwn(metadata.agentSessions ?? {}, sessionKey) && !isSessionSaved(metadata, sessionKey)
  )
}

/** The note added once; a session already noted keeps its first launch time. */
export function withAgentSessionNote(
  metadata: SessionFolderMetadata,
  sessionKey: string,
  at = Date.now()
): SessionFolderMetadata {
  return Object.hasOwn(metadata.agentSessions ?? {}, sessionKey)
    ? metadata
    : { ...metadata, agentSessions: { ...metadata.agentSessions, [sessionKey]: at } }
}

/** A person filed these where they wanted: they are the person's own now. */
export function withoutAgentSessionNotes(
  metadata: SessionFolderMetadata,
  sessionKeys: readonly string[]
): SessionFolderMetadata {
  if (!sessionKeys.some((key) => Object.hasOwn(metadata.agentSessions ?? {}, key))) {
    return metadata
  }
  const agentSessions = { ...metadata.agentSessions }
  for (const key of sessionKeys) {
    delete agentSessions[key]
  }
  return { ...metadata, agentSessions }
}

/** This computer's note, or the paired owner's for a row that mirrors one of its sessions. */
export function isAgentSession(
  metadata: SessionFolderMetadata,
  session: Pick<SidebarSession, 'sessionKey' | 'rowKey' | 'mirroredConversation'>
): boolean {
  const key = conversationViewKey(session)
  return (
    isAgentLaunchedSession(metadata, key) ||
    (session.mirroredConversation?.agentSessionByOwner === true && !isSessionSaved(metadata, key))
  )
}

/**
 * The rows the Agent sessions group lists: workers whose launcher is not listed, sessions an
 * agent launched, and the workers listed under those (they go where their launcher goes).
 */
export function agentSessionRowKeys(
  nested: {
    rows: readonly SessionSidebarTreeRow[]
    workersByRowKey: ReadonlyMap<string, readonly SessionSidebarTreeRow[]>
  },
  orphanRowKeys: ReadonlySet<string>,
  metadata: SessionFolderMetadata
): Set<string> {
  const { rows, workersByRowKey } = nested
  const keys = new Set(orphanRowKeys)
  for (const row of rows) {
    if (isAgentSession(metadata, row.session)) {
      keys.add(row.session.rowKey)
    }
  }
  // Why iterate while adding: a Set visits what is added, so nested workers follow too.
  for (const key of keys) {
    for (const worker of workersByRowKey.get(key) ?? []) {
      keys.add(worker.session.rowKey)
    }
  }
  return keys
}

/**
 * The rows as the person's folders hold them: an agent session lists in Agent sessions, so it is
 * neither counted in nor keeps open the folder its launcher filed it in. `emptied`: folders only
 * agent sessions filled, so a batch of them leaves the view as a finished batch does.
 */
export function personFolderRows<T extends SessionSidebarTreeRow>(
  rows: readonly T[],
  agentRowKeys: ReadonlySet<string>,
  classifications: ReadonlyMap<string, string>
): { rows: T[]; emptied: Set<string> } {
  const kept = new Set<string>()
  const moved = new Set<string>()
  const filed = rows.map((row) => {
    const away =
      !row.archived &&
      agentRowKeys.has(row.session.rowKey) &&
      classifications.get(row.session.rowKey) !== 'saved'
    if (row.folderId) {
      ;(away ? moved : kept).add(row.folderId)
    }
    return away && row.folderId ? { ...row, folderId: null } : row
  })
  return { rows: filed, emptied: new Set([...moved].filter((id) => !kept.has(id))) }
}
