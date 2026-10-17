import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnOutcome,
  AgentJournalTurnSettlement
} from '../../shared/agent-session-journal-types'
import {
  ADMITTED,
  appendLifecycleMutations,
  codexTurnOutcomeMutation,
  exitSettlementId,
  interruptedBody
} from './codex-journal-settlement-mutations'
import { codexTurnSettlementMutations } from './codex-structured-journal-translation-turns'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundJournalStatusText,
  cancelledJournalPromptBody
} from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem,
  type CodexTurnOrdinals
} from './codex-structured-item-translation'
import type { CodexStructuredItemStreams } from './codex-structured-item-streams'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'

export type CodexActiveJournalItem = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
}

export type CodexPendingJournalPrompt = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

export function settleCodexJournalSession(input: {
  event: Extract<CodexStructuredSessionEvent, { type: 'ended' }>
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: ReadonlyMap<string, CodexActiveJournalItem>
  pendingPrompts: ReadonlyMap<string, CodexPendingJournalPrompt>
  currentTurnIds: ReadonlyMap<string, ReadonlySet<string>>
  primaryThreadId: string | null
  ordinals: CodexTurnOrdinals
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleMutationInput[] = []
  const turnOrdinalsToForget: { threadId: string; turnId: string }[] = []
  for (const active of input.activeItems.values()) {
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
  }
  for (const prompt of input.pendingPrompts.values()) {
    const body = cancelledJournalPromptBody(prompt.body)
    if (body) {
      mutations.push({
        kind: 'item',
        identity: prompt.identity,
        body
      })
    }
  }
  if (!('cause' in input.event) || input.event.cause === 'unexpected-exit') {
    mutations.push({
      kind: 'item',
      identity: { provider: 'omni', clientMessageId: exitSettlementId(input.event) },
      body: {
        kind: 'status',
        text: boundJournalStatusText(`Provider exited: ${input.event.reason}`)
      }
    })
  }
  for (const [threadId, turnIds] of input.currentTurnIds) {
    if (input.primaryThreadId !== threadId) {
      continue
    }
    for (const turnId of turnIds) {
      mutations.push({
        kind: 'tombstone',
        identity: {
          provider: 'legacy',
          agent: 'codex',
          sessionId: input.event.sessionId,
          recordId: `turn-lifecycle:${turnId}`
        }
      })
      // The provider went away mid-turn: how it ended is unknown, never completion.
      mutations.push(codexTurnOutcomeMutation(input.event.sessionId, turnId, 'unknown'))
      turnOrdinalsToForget.push({ threadId, turnId })
    }
  }
  const admission = appendLifecycleMutations(input.sink, exitSettlementId(input.event), mutations)
  if (!admission.accepted) {
    return admission
  }
  for (const { threadId, turnId } of turnOrdinalsToForget) {
    input.ordinals.forgetTurn(threadId, turnId)
  }
  return ADMITTED
}

export function settleCodexJournalTurn(input: {
  sessionId: string
  threadId: string
  turnId: string
  /** Only the primary thread publishes lifecycle rows, as `publishCodexTurnLifecycle` does. */
  primaryThreadId?: string | null
  /** How the turn ended; a completion released after an interrupt is not plain completion. */
  outcome?: AgentJournalTurnOutcome
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
  steeringClientMessageId?: string
  settlement?: AgentJournalTurnSettlement
  failureReason?: string
}): StructuredAgentSessionSinkAdmission {
  const mutations: JournalLifecycleMutationInput[] = []
  const activeItemsToForget: { key: string; threadId: string; itemId: string }[] = []
  for (const [key, active] of input.activeItems) {
    if (active.threadId !== input.threadId || active.turnId !== input.turnId) {
      continue
    }
    if (codexCommandOutlivesTurn(active.item)) {
      continue
    }
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  mutations.push(...codexTurnSettlementMutations(input))
  mutations.push({
    kind: 'tombstone',
    identity: {
      provider: 'legacy',
      agent: 'codex',
      sessionId: input.sessionId,
      recordId: `turn-lifecycle:${input.turnId}`
    }
  })
  if (input.primaryThreadId === input.threadId) {
    mutations.push(
      codexTurnOutcomeMutation(input.sessionId, input.turnId, input.outcome ?? 'completed')
    )
  }
  const admission = appendLifecycleMutations(
    input.sink,
    `turn-completed:${input.sessionId}:${input.threadId}:${input.turnId}`,
    mutations
  )
  if (!admission.accepted) {
    return admission
  }
  for (const active of activeItemsToForget) {
    input.streams.forget(active.threadId, active.itemId)
    input.activeItems.delete(active.key)
  }
  return ADMITTED
}

/** Settle streamed items whose terminal notification was rejected as oversized. */
export function settleCodexOversizedNotification(input: {
  sessionId: string
  threadId: string
  method: string
  sink: StructuredAgentSessionEventSink
  streams: CodexStructuredItemStreams
  activeItems: Map<string, CodexActiveJournalItem>
}): StructuredAgentSessionSinkAdmission {
  const itemType = oversizedStreamItemType(input.method)
  if (!itemType) {
    return ADMITTED
  }
  const mutations: JournalLifecycleMutationInput[] = []
  const activeItemsToForget: { key: string; threadId: string; itemId: string }[] = []
  for (const [key, active] of input.activeItems) {
    if (active.threadId !== input.threadId || active.item.type !== itemType) {
      continue
    }
    const streamed = input.streams.snapshot(active.threadId, active.item.id)
    const translated = streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item)
    const body = interruptedBody(translated.body)
    if (body) {
      mutations.push({ kind: 'item', identity: active.identity, body })
    }
    activeItemsToForget.push({ key, threadId: active.threadId, itemId: active.item.id })
  }
  if (mutations.length === 0) {
    return ADMITTED
  }
  const admission = appendLifecycleMutations(
    input.sink,
    `oversized-notification:${input.sessionId}:${input.threadId}:${input.method}`,
    mutations
  )
  if (!admission.accepted) {
    return admission
  }
  for (const active of activeItemsToForget) {
    input.streams.forget(active.threadId, active.itemId)
    input.activeItems.delete(active.key)
  }
  return ADMITTED
}

function oversizedStreamItemType(method: string): CodexThreadItem['type'] | null {
  if (method === 'item/agentMessage/delta') {
    return 'agentMessage'
  }
  if (method === 'item/plan/delta') {
    return 'plan'
  }
  if (
    method === 'command/exec/outputDelta' ||
    method === 'process/outputDelta' ||
    method === 'item/commandExecution/outputDelta' ||
    method === 'item/commandExecution/terminalInteraction'
  ) {
    return 'commandExecution'
  }
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') {
    return 'fileChange'
  }
  if (
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/summaryPartAdded' ||
    method === 'item/reasoning/textDelta'
  ) {
    return 'reasoning'
  }
  return null
}
