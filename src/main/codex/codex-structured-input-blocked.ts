import { randomUUID } from 'node:crypto'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalStatusItem
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD,
  CODEX_LEGACY_EXEC_APPROVAL_METHOD
} from './codex-server-request-disposition'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
} from './codex-structured-prompt-replies'

const INPUT_METHODS = new Set([
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD,
  CODEX_LEGACY_EXEC_APPROVAL_METHOD,
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
])

/** Only the responded server-request path calls this; generic frames are never authority. */
export function publishCodexInputBlocked(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string | null
  method: string
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId || !INPUT_METHODS.has(input.method)) {
    return { accepted: true }
  }
  const providerItemId = input.turnId
    ? agentJournalItemKey({
        provider: 'codex',
        threadId: input.threadId,
        turnId: input.turnId,
        ordinal: 0
      })
    : null
  const identity: AgentJournalItemIdentity = {
    provider: 'legacy',
    agent: 'codex',
    sessionId: input.sessionId,
    // Unknown turns need fresh sequence positions even after a provider restart.
    recordId: `input-blocked:${providerItemId ?? randomUUID()}`
  }
  const body: AgentJournalStatusItem = {
    kind: 'status',
    text: 'The agent requested input that could not be provided.',
    inputBlocked: { providerItemId, reason: 'provider-request-declined' }
  }
  if (input.sink.tryAppendItem) {
    const admission = input.sink.tryAppendItem(identity, body, { lifecycle: true })
    if (!admission.accepted) {
      return admission
    }
  } else {
    input.sink.appendItem(identity, body, { lifecycle: true })
  }
  if (input.sink.tryPublish) {
    return input.sink.tryPublish({ lifecycle: true })
  }
  input.sink.publish({ lifecycle: true })
  return { accepted: true }
}
