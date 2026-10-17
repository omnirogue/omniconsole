/**
 * Which request launched a batch folder and each session filed in it. Kept by the window in a
 * per-device store, never in folder metadata or account sync: current and older app versions
 * drop folder fields they do not recognise, and sync carries only a fixed set. Anything missing
 * from the store is the person's.
 */

export const SESSION_BATCH_REQUEST_EXCERPT_LIMIT = 200

export type SessionBatchFolderOrigin = {
  folderId: string
  batchId: string
  /** The person's own words, trimmed to SESSION_BATCH_REQUEST_EXCERPT_LIMIT. */
  requestExcerpt: string
  createdAt: number
  source: 'session-prep'
}

export type SessionBatchSessionOrigin = {
  batchId: string
  /** The item's position in its batch. */
  index: number
  /** A competing or reviewing session: the steward never suggests merging it. */
  independent?: true
}

/** What the window remembers: batch folders by folder id, their sessions by session key. */
export type SessionBatchOriginsSnapshot = {
  folders: Record<string, SessionBatchFolderOrigin>
  sessions: Record<string, SessionBatchSessionOrigin & { at: number }>
}

/** What main asks the window to remember (or, `listBatchOrigins`, to read) over the folder relay. */
export type SessionBatchOriginRequest =
  | { kind: 'recordBatchFolder'; origin: SessionBatchFolderOrigin }
  | { kind: 'recordBatchSession'; sessionKey: string; origin: SessionBatchSessionOrigin }
  | { kind: 'listBatchOrigins' }

export function sessionBatchRequestExcerpt(request: string): string {
  const folded = request.replace(/\s+/g, ' ').trim()
  return folded.length <= SESSION_BATCH_REQUEST_EXCERPT_LIMIT
    ? folded
    : `${folded.slice(0, SESSION_BATCH_REQUEST_EXCERPT_LIMIT - 1).trimEnd()}…`
}
