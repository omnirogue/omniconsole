/**
 * One provider conversation on one execution host, as `omni session search` hits, `session list`
 * rows and every `--ref` name it: `<agent>:<sessionId>@<host>`. It names the conversation, never a
 * pane: the pane is found from it when a command acts, and two panes holding one conversation are
 * ambiguous until one is named with --pane.
 */

import { sessionManageHostKey } from './session-manage-query'

export type SessionReferenceAgent = 'claude' | 'codex'

export type SessionReference = {
  agent: SessionReferenceAgent
  /** The transcript's own id: what `claude --resume` / `codex resume` take. */
  sessionId: string
  /** `local`, `ssh:<id>` or `runtime:<id>`, normalized by `sessionManageHostKey`. */
  hostId: string
}

/** A conversation to find rows for; a search hit adds the transcript it was read from. */
export type SessionReferenceTarget = Pick<SessionReference, 'sessionId' | 'hostId'> & {
  transcriptPath?: string | null
}

/** What a row needs for the join: its host and the provider conversation its agent reported. */
export type SessionReferenceRow = {
  hostId: string | null
  agent?: string | null
  providerSessionId?: string | null
  transcriptPath?: string | null
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export function isSessionReferenceAgent(
  value: string | null | undefined
): value is SessionReferenceAgent {
  return value === 'claude' || value === 'codex'
}

export function formatSessionReference(reference: SessionReference): string {
  return `${reference.agent}:${reference.sessionId}@${reference.hostId}`
}

export function parseSessionReference(value: string): SessionReference | null {
  const trimmed = value.trim()
  const at = trimmed.indexOf('@')
  const colon = trimmed.indexOf(':')
  if (at === -1 || colon === -1 || colon > at) {
    return null
  }
  const agent = trimmed.slice(0, colon)
  const sessionId = trimmed.slice(colon + 1, at)
  const hostId = sessionManageHostKey(trimmed.slice(at + 1))
  if (!isSessionReferenceAgent(agent) || !SESSION_ID.test(sessionId) || !hostId) {
    return null
  }
  return { agent, sessionId, hostId }
}

/** The id a transcript file is named by: a Codex rollout's UUID tail, else the file name. */
export function transcriptSessionIdOf(path: string): string {
  const match = UUID_TAIL.exec(path)
  if (match) {
    return match[1]!.toLowerCase()
  }
  const name = path.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.jsonl$/i, '')
}

/**
 * The row holds this conversation: same host, and its agent reported this id or a transcript of
 * this name. Why both: Claude can name the transcript with a UUID other than its hook session id.
 */
export function rowHoldsSessionReference(
  reference: SessionReferenceTarget,
  row: SessionReferenceRow
): boolean {
  if (sessionManageHostKey(row.hostId) !== reference.hostId) {
    return false
  }
  const id = reference.sessionId.toLowerCase()
  return (
    row.providerSessionId?.toLowerCase() === id ||
    (row.transcriptPath ? transcriptSessionIdOf(row.transcriptPath).toLowerCase() === id : false) ||
    (Boolean(reference.transcriptPath) && row.transcriptPath === reference.transcriptPath)
  )
}

/** Every row holding the conversation, in order; one pane per conversation is the actionable case. */
export function rowsForSessionReference<T extends SessionReferenceRow>(
  reference: SessionReferenceTarget,
  rows: readonly T[]
): T[] {
  return rows.filter((row) => rowHoldsSessionReference(reference, row))
}

/** A row's own reference, when its agent reported a Claude or Codex conversation on a known host. */
export function sessionReferenceForRow(row: SessionReferenceRow): string | null {
  const agent = row.agent?.toLowerCase() ?? null
  const hostId = sessionManageHostKey(row.hostId)
  const sessionId = row.transcriptPath
    ? transcriptSessionIdOf(row.transcriptPath)
    : (row.providerSessionId ?? null)
  if (!isSessionReferenceAgent(agent) || !hostId || !sessionId || !SESSION_ID.test(sessionId)) {
    return null
  }
  return formatSessionReference({ agent, sessionId, hostId })
}
