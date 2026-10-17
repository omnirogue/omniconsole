import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'

export type LedgerResumeIdentity = {
  worktreeId: string
  agent: string
  nativeSessionId: string
  nativeSessionKey: 'session_id' | 'conversation_id'
  connectionId: string | null
  /** Claude's session file; its absence means the id cannot be resumed. */
  sessionFilePath?: string
}

export function readLedgerResumeIdentity(value: unknown): LedgerResumeIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const row = value as Partial<LedgerResumeIdentity>
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096
  return text(row.worktreeId) &&
    text(row.agent) &&
    text(row.nativeSessionId) &&
    (row.nativeSessionKey === 'session_id' || row.nativeSessionKey === 'conversation_id') &&
    (row.connectionId === null || text(row.connectionId))
    ? {
        worktreeId: row.worktreeId,
        agent: row.agent,
        nativeSessionId: row.nativeSessionId,
        nativeSessionKey: row.nativeSessionKey,
        ...(text(row.sessionFilePath) ? { sessionFilePath: row.sessionFilePath } : {}),
        connectionId: row.connectionId
      }
    : null
}

export type PersistedPane = {
  paneKey: string
  ledgerId: string
  repo?: string | null
  branch?: string | null
  cardId?: string | null
  cardTitle?: string | null
  resumeIdentity?: LedgerResumeIdentity
  verifiedResumeIdentity?: LedgerResumeIdentity
  /** `'person'` when someone added the conversation to that task themselves; see LedgerPaneEntry. */
  cardLinkedBy?: 'workspace' | 'person' | null
  /** The account the row was opened under; a restored row stays bound to it (contract §0b.11). */
  account?: string | null
  startedAt: string
}

export type LedgerPaneStore = {
  load(): PersistedPane[]
  save(entries: PersistedPane[]): void
}

export const LEDGER_PANE_REGISTRY_MAX = 512

function isPersistedPane(value: unknown): value is PersistedPane {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<PersistedPane>
  return (
    typeof record.paneKey === 'string' &&
    record.paneKey.length > 0 &&
    typeof record.ledgerId === 'string' &&
    LEDGER_ID_PATTERN.test(record.ledgerId) &&
    typeof record.startedAt === 'string' &&
    (record.account === undefined || record.account === null || typeof record.account === 'string')
  )
}

export function parsePersistedPanes(value: unknown): PersistedPane[] {
  return Array.isArray(value) ? value.filter(isPersistedPane).slice(-LEDGER_PANE_REGISTRY_MAX) : []
}
