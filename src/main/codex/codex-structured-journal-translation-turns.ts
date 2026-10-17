import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalTurnSettlement } from '../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function codexTurnSettlementMutations(input: {
  sessionId: string
  threadId: string
  turnId: string
  settlement?: AgentJournalTurnSettlement
  failureReason?: string
  steeringClientMessageId?: string
}): JournalLifecycleMutationInput[] {
  if (!input.settlement) {
    return []
  }
  const settlements = [input.settlement]
  if (input.steeringClientMessageId) {
    settlements.push({
      ...input.settlement,
      providerItemId: agentJournalItemKey({
        provider: 'omni',
        clientMessageId: input.steeringClientMessageId
      })
    })
  }
  return settlements.map((settlement, index) => ({
    kind: 'item',
    identity: {
      provider: 'legacy',
      agent: 'codex',
      sessionId: input.sessionId,
      recordId: `turn-settlement:${input.threadId}:${input.turnId}${index ? `:steer:${input.steeringClientMessageId}` : ''}`
    },
    body: {
      kind: 'status',
      text:
        settlement.outcome === 'failed'
          ? (input.failureReason ?? 'Codex stopped without completing the request.')
          : settlement.outcome === 'cancelled'
            ? 'Codex was interrupted.'
            : '',
      turnLifecycle: { turnId: input.turnId, state: 'completed', settlement }
    }
  }))
}

export function codexTurnSettlement(
  params: unknown,
  threadId: string,
  turnId: string,
  interrupted = false
): AgentJournalTurnSettlement | undefined {
  const root = readCodexJournalRecord(params)
  const turn = readCodexJournalRecord(root.turn)
  if (
    turn.id !== turnId ||
    typeof turn.status !== 'string' ||
    !['completed', 'interrupted', 'failed'].includes(turn.status)
  ) {
    return undefined
  }
  return {
    providerItemId: agentJournalItemKey({ provider: 'codex', threadId, turnId, ordinal: 0 }),
    outcome:
      turn.error != null || root.error != null || turn.status === 'failed'
        ? 'failed'
        : interrupted || turn.status === 'interrupted'
          ? 'cancelled'
          : 'succeeded'
  }
}

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: 'running' | 'completed'
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId) {
    return ADMITTED
  }
  const identity = {
    provider: 'legacy' as const,
    agent: 'codex' as const,
    sessionId: input.sessionId,
    recordId: `turn-lifecycle:${input.turnId}`
  }
  if (input.state === 'completed') {
    if (input.sink.tryAppendTombstone) {
      // OmniConsole: 'turn-ended' is the hub task publication checkpoint.
      const admission = input.sink.tryAppendTombstone(identity, {
        lifecycle: true,
        checkpoint: 'turn-ended'
      })
      if (!admission.accepted) {
        return admission
      }
    } else {
      input.sink.appendTombstone(identity, { lifecycle: true, checkpoint: 'turn-ended' })
    }
  } else {
    const admission = input.sink.tryAppendItem
      ? input.sink.tryAppendItem(
          identity,
          {
            kind: 'status',
            text: 'Codex is working…',
            turnLifecycle: { turnId: input.turnId, state: input.state }
          },
          { lifecycle: true }
        )
      : (input.sink.appendItem(
          identity,
          {
            kind: 'status',
            text: 'Codex is working…',
            turnLifecycle: { turnId: input.turnId, state: input.state }
          },
          { lifecycle: true }
        ),
        ADMITTED)
    if (!admission.accepted) {
      return admission
    }
  }
  if (input.sink.tryPublish) {
    return input.sink.tryPublish({ lifecycle: true })
  }
  input.sink.publish({ lifecycle: true })
  return ADMITTED
}
