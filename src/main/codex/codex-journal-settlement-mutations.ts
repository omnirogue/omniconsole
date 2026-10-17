// How a Codex settlement shapes its rows and writes them: the durable mutations a settling
// turn or session leaves behind, and the admission path that appends them in bounded chunks.

import type {
  AgentJournalItemBody,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import {
  endsTurnLifecycle,
  isTurnLifecycleIdentity
} from './codex-structured-journal-turn-boundary'
import { partitionJournalLifecycleMutations } from '../native-chat/agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

export const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** Codex tombstones its running row, so the settled outcome is published as its own durable row. */
export function codexTurnOutcomeMutation(
  sessionId: string,
  turnId: string,
  outcome: AgentJournalTurnOutcome
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: {
      provider: 'legacy',
      agent: 'codex',
      sessionId,
      recordId: `turn-outcome:${turnId}`
    },
    body: {
      kind: 'status',
      text: '',
      turnLifecycle: { turnId, state: 'completed', outcome }
    }
  }
}

export function appendLifecycleMutations(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
): StructuredAgentSessionSinkAdmission {
  const chunks = partitionJournalLifecycleMutations(settlementId, mutations)
  for (const { settlementId: id, mutations: chunk } of chunks) {
    let admission: StructuredAgentSessionSinkAdmission = ADMITTED
    // OmniConsole: the chunk that retires the turn-lifecycle row IS the turn
    // boundary the hub task publication checkpoints on.
    const options = endsTurnLifecycle(chunk)
      ? ({ lifecycle: true, checkpoint: 'turn-ended' } as const)
      : ({ lifecycle: true } as const)
    if (sink.tryAppendLifecycleBatch) {
      admission = sink.tryAppendLifecycleBatch(id, chunk, options)
    } else if (sink.appendLifecycleBatch) {
      admission = sink.appendLifecycleBatch(id, chunk, options) ?? ADMITTED
    } else {
      for (const mutation of chunk) {
        if (mutation.kind === 'item') {
          if (sink.tryAppendItem) {
            admission = sink.tryAppendItem(mutation.identity, mutation.body, { lifecycle: true })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendItem(mutation.identity, mutation.body, { lifecycle: true })
          }
        } else {
          const tombstoneOptions = isTurnLifecycleIdentity(mutation.identity)
            ? ({ lifecycle: true, checkpoint: 'turn-ended' } as const)
            : ({ lifecycle: true } as const)
          if (sink.tryAppendTombstone) {
            admission = sink.tryAppendTombstone(mutation.identity, tombstoneOptions)
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendTombstone(mutation.identity, tombstoneOptions)
          }
        }
      }
    }
    if (!admission.accepted) {
      return admission
    }
    const publishAdmission = sink.tryPublish
      ? sink.tryPublish({ lifecycle: true })
      : (sink.publish({ lifecycle: true }), ADMITTED)
    if (!publishAdmission.accepted) {
      return publishAdmission
    }
  }
  return ADMITTED
}

export function interruptedBody(body: AgentJournalItemBody | null): AgentJournalItemBody | null {
  if (!body) {
    return null
  }
  if (body.kind === 'tool-call') {
    return { ...body, state: 'failed' }
  }
  if (body.kind === 'message') {
    return body
  }
  return body.kind === 'diff'
    ? { kind: 'status', text: 'File changes were interrupted before completion.' }
    : body
}

export function exitSettlementId(
  event: Extract<CodexStructuredSessionEvent, { type: 'ended' }>
): string {
  const fence = 'fence' in event ? event.fence : 0
  const generation = 'acquisitionGeneration' in event ? event.acquisitionGeneration : 'legacy'
  return `provider-exit:${event.sessionId}:${fence}:${generation}`
}
