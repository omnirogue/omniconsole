import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { LedgerBatchEnvelope, LedgerEventDetail } from '../../shared/session-ledger-contract'
import type { LedgerPaneEntry } from './ledger-identity'

/** The batch header for a pane's row; `employee_id` is never part of it (identity is the principal). */
export function batchEnvelope(entry: LedgerPaneEntry, host: string): LedgerBatchEnvelope {
  return {
    ledger_id: entry.ledgerId,
    attempt_id: entry.attemptId,
    app: 'omni-ide',
    agent: entry.agent,
    model: entry.model,
    host,
    native_session_id: entry.nativeSessionId,
    repo: entry.repo,
    branch: entry.branch,
    card_id: entry.cardId,
    card_title: entry.cardTitle,
    started_at: entry.startedAt
  }
}

/**
 * The row's opening event for this attempt, or null once it went out. Always sent on the
 * first hook of an attempt — even if the connector reached the console first — so the
 * console can promote the row (contract §4).
 */
export function pendingStartEvent(entry: LedgerPaneEntry): LedgerEventDetail | null {
  if (!entry.pendingStart) {
    return null
  }
  return entry.pendingStart === 'session_start'
    ? {
        kind: 'session_start',
        detail: {
          cwd_kind: entry.repo ? 'repo' : 'folder',
          ...(entry.agent ? { agent: entry.agent } : {}),
          ...(entry.model ? { model: entry.model } : {})
        }
      }
    : { kind: 'attempt_start', detail: { reason: entry.attemptReason } }
}

/** What one hook status teaches about the row's identity (agent, model, native id, workspace). */
export function hookIdentityPatch(
  entry: LedgerPaneEntry,
  status: {
    source?: string
    worktreeId?: string
    connectionId?: string | null
    providerSession?: Partial<AgentProviderSessionMetadata>
    payload: { agentType?: string; model?: string }
  }
): Partial<LedgerPaneEntry> {
  const patch: Partial<LedgerPaneEntry> = {}
  const agent = status.payload.agentType ?? status.source
  if (agent && agent !== entry.agent) {
    patch.agent = agent
  }
  if (status.payload.model && status.payload.model !== entry.model) {
    patch.model = status.payload.model
  }
  if (status.providerSession?.transcriptPath) {
    patch.sessionFilePath = status.providerSession.transcriptPath
  } else if (status.providerSession?.id && status.providerSession.id !== entry.nativeSessionId) {
    patch.sessionFilePath = undefined
  }
  const nativeSessionId = status.providerSession?.id
  if (nativeSessionId && nativeSessionId !== entry.nativeSessionId) {
    patch.nativeSessionId = nativeSessionId
  }
  if (status.providerSession?.key && status.providerSession.key !== entry.nativeSessionKey) {
    patch.nativeSessionKey = status.providerSession.key
  }
  if (
    (status.connectionId !== undefined || !entry.remote) &&
    (status.connectionId ?? null) !== entry.connectionId
  ) {
    patch.connectionId = status.connectionId ?? null
  }
  if (status.worktreeId && !entry.worktreeId) {
    patch.worktreeId = status.worktreeId
  }
  if (status.connectionId && !entry.remote) {
    patch.remote = true
  }
  return patch
}
