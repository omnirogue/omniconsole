/**
 * Reads one agent status report as a next-step signal: a lead turn that finished with a reply,
 * a turn that finished but must not get suggestions (and why), or the pane going busy again.
 */

import { ASSISTANT_MESSAGE_TRIMMED_MARKER } from '../../shared/agent-status-field-normalization'
import type { AgentStatusPayload } from '../../shared/agent-status-types'
import { describeAgentTurnFailure } from '../../shared/agent-turn-failure'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredConversationSource,
  type ConversationSource
} from '../../shared/conversation-source'
import { nextStepTurnKey } from '../../shared/next-step-suggestions-rpc'

/**
 * Where a turn falls in its conversation: `order` is the host's own monotonic mark (a hook row's
 * completion time, a chat journal's sequence), `completedAt` a wall-clock time for comparing
 * against a transcript. Absent only on turns built by hand.
 */
export type TurnPlacement = { order?: number; completedAt?: number }

export type FinishedTurn = TurnPlacement & {
  conversation: ConversationSource
  turnKey: string
  /** The working agent's type (`claude`, `codex`, …). */
  agent?: string
  lastAssistantMessage: string
  /** `lastAssistantMessage` is the whole reply: not trimmed, not a preview. */
  replyComplete?: true
  lastUserPrompt?: string
}

export type TurnSignal =
  | { kind: 'finished'; turn: FinishedTurn }
  | ({
      kind: 'skip'
      conversation?: ConversationSource
      turnKey: string
      reason: string
    } & TurnPlacement)
  | { kind: 'busy'; conversation: ConversationSource }
  | { kind: 'ignore' }

/** The hook-row fields a signal is read from; a live event and a status snapshot both carry them. */
export type HookTurnEvidence = {
  paneKey: string
  worktreeId?: string
  hookEventName?: string
  toolAgentId?: string
  isReplay?: boolean
  restoredUnconfirmed?: boolean
  stateStartedAt: number
  payload: Pick<
    AgentStatusPayload,
    | 'state'
    | 'agentType'
    | 'prompt'
    | 'lastAssistantMessage'
    | 'lastAssistantMessageIsToolOutput'
    | 'interactivePrompt'
    | 'failed'
    | 'failureReason'
    | 'interrupted'
    | 'sessionBoundary'
    | 'turnCompletedAt'
  >
}

// A child's or teammate's event is THEIR work, never the lead turn the person is waiting on.
const CHILD_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'TeammateIdle'])

export const NO_WORKSPACE_REASON =
  'This pane is not attributed to a workspace, so suggestions have nowhere to go.'

function unfinishedReason(payload: HookTurnEvidence['payload']): string | null {
  if (payload.failed) {
    return describeAgentTurnFailure(payload.failureReason)
  }
  if (payload.interrupted) {
    return 'The turn was interrupted before it finished.'
  }
  if (payload.interactivePrompt) {
    return 'The agent is waiting for an answer to its own question.'
  }
  if (payload.lastAssistantMessageIsToolOutput) {
    return "The turn's last output came from a tool, not from the agent's reply."
  }
  if (!payload.lastAssistantMessage?.trim()) {
    return 'The turn ended without a reply to suggest from.'
  }
  return null
}

export function classifyHookTurnSignal(
  event: HookTurnEvidence,
  resolveWorktreeId?: (paneKey: string) => string | null
): TurnSignal {
  if (
    event.isReplay ||
    event.restoredUnconfirmed ||
    event.toolAgentId ||
    (event.hookEventName !== undefined && CHILD_EVENTS.has(event.hookEventName))
  ) {
    return { kind: 'ignore' }
  }
  const worktreeId = event.worktreeId ?? resolveWorktreeId?.(event.paneKey) ?? null
  const conversation: ConversationSource | undefined = worktreeId
    ? { worktreeId, paneKey: event.paneKey, kind: 'pty' }
    : undefined
  const { payload } = event
  if (payload.state !== 'done') {
    return conversation ? { kind: 'busy', conversation } : { kind: 'ignore' }
  }
  if (payload.sessionBoundary) {
    return { kind: 'ignore' }
  }
  const mark = payload.turnCompletedAt ?? event.stateStartedAt
  const turnKey = nextStepTurnKey(event.paneKey, mark)
  const placement = { order: mark, completedAt: mark }
  if (!conversation) {
    return { kind: 'skip', turnKey, reason: NO_WORKSPACE_REASON, ...placement }
  }
  const reason = unfinishedReason(payload)
  if (reason) {
    return { kind: 'skip', conversation, turnKey, reason, ...placement }
  }
  const prompt = payload.prompt?.trim()
  return {
    kind: 'finished',
    turn: {
      conversation,
      turnKey,
      ...placement,
      ...(payload.agentType ? { agent: payload.agentType } : {}),
      lastAssistantMessage: payload.lastAssistantMessage!,
      ...(payload.lastAssistantMessage!.includes(ASSISTANT_MESSAGE_TRIMMED_MARKER)
        ? {}
        : { replyComplete: true as const }),
      ...(prompt ? { lastUserPrompt: prompt } : {})
    }
  }
}

/** The journal's reading of a chat session's last turn (`host.turnState`). */
export type StructuredTurnFacts = {
  running: boolean
  hasTurn: boolean
  awaitingStart: boolean
  outcome: string
  lastSequence: number
}

/** A turn the journal has not settled yet: re-read on later updates, not a finished turn. */
export function isUnsettledStructuredTurn(turn: StructuredTurnFacts | null): boolean {
  return Boolean(
    turn && !turn.running && !turn.awaitingStart && turn.hasTurn && turn.outcome === 'unknown'
  )
}

function settledOutcomeReason(outcome: string, failureReason?: string): string | null {
  if (outcome === 'completed') {
    return null
  }
  if (outcome === 'failed') {
    return describeAgentTurnFailure(failureReason)
  }
  return outcome === 'interrupted' || outcome === 'cancelled'
    ? 'The turn was interrupted before it finished.'
    : `The turn ended without finishing (${outcome}).`
}

/**
 * A chat session's status projection. Only a `working → idle` edge whose journal shows the turn
 * settled as `completed` is a finished turn; any other settled outcome is skipped with its reason,
 * and a submit flicker (`awaitingStart`) or an unsettled turn is not a turn yet. The reply itself is
 * read from the journal by the caller, since the projection holds a preview.
 */
export function classifyStructuredStatus(
  previous: AgentSessionStatusSummary['status'] | undefined,
  summary: AgentSessionStatusSummary,
  turn: StructuredTurnFacts | null
): TurnSignal {
  const conversation = structuredConversationSource(summary.workspaceId, summary.sessionId)
  if (summary.status === 'working') {
    return { kind: 'busy', conversation }
  }
  if (
    previous !== 'working' ||
    summary.status !== 'idle' ||
    !turn ||
    turn.running ||
    turn.awaitingStart ||
    !turn.hasTurn ||
    turn.outcome === 'unknown'
  ) {
    return { kind: 'ignore' }
  }
  const turnKey = nextStepTurnKey(conversation.paneKey, turn.lastSequence)
  const placement = { order: turn.lastSequence, completedAt: summary.updatedAt }
  const reason =
    settledOutcomeReason(turn.outcome, summary.failureReason) ??
    unfinishedReason({
      state: 'done',
      failed: summary.failed,
      failureReason: summary.failureReason,
      interrupted: summary.interrupted,
      lastAssistantMessage: summary.lastAssistantMessage
    })
  if (reason) {
    return { kind: 'skip', conversation, turnKey, reason, ...placement }
  }
  const prompt = summary.latestPrompt.trim()
  return {
    kind: 'finished',
    turn: {
      conversation,
      turnKey,
      ...placement,
      agent: summary.agent,
      lastAssistantMessage: summary.lastAssistantMessage!,
      ...(prompt ? { lastUserPrompt: prompt } : {})
    }
  }
}
