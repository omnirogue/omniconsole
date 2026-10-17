import type {
  AgentJournalRenderItem,
  AgentJournalTurnOutcome
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import {
  activeStructuredAgentSessionTurnId,
  hasPersistedStructuredAgentSessionTurn
} from '../../../shared/structured-agent-session-projection'

export type StructuredAgentSessionTurnState = {
  activeTurnId: string | null
  lifecycleKnown: boolean
  running: boolean
  hasTurn: boolean
  /** A user message is journaled but its provider turn has not reported running or settled yet. */
  awaitingStart: boolean
  /** How the last turn ended. Only `completed` is evidence the source finished. */
  outcome: AgentJournalTurnOutcome
  lastSequence: number
}

/** The history page can omit an older running row, so attach full owner turn facts. */
export function withOwnerTurnState(
  result: AgentSessionHistoryResult,
  turn: StructuredAgentSessionTurnState | null
): AgentSessionHistoryResult {
  return result.ok && turn
    ? {
        ...result,
        turnState: {
          activeTurnId: turn.activeTurnId,
          lifecycleKnown: turn.lifecycleKnown,
          awaitingStart: turn.awaitingStart
        }
      }
    : result
}

function lastLifecycleIndex(items: readonly AgentJournalRenderItem[]): number {
  return items.findLastIndex(
    (item) => item.body.kind === 'status' && Boolean(item.body.turnLifecycle)
  )
}

function awaitingTurnStart(items: readonly AgentJournalRenderItem[]): boolean {
  const lastUser = items.findLastIndex(
    (item) => item.body.kind === 'message' && item.body.role === 'user'
  )
  const lastLifecycle = lastLifecycleIndex(items)
  if (lastUser === -1 || lastLifecycle > lastUser) {
    return false
  }
  // Why: chat journals persist the submitted message before the provider's running row; a
  // journal that never carries lifecycle rows can only be judged by the assistant's reply.
  return (
    lastLifecycle !== -1 ||
    !items
      .slice(lastUser + 1)
      .some((item) => item.body.kind === 'message' && item.body.role === 'assistant')
  )
}

/**
 * Providers that tombstone their running row (Codex) publish a settled row carrying the
 * outcome; a journal with no settled row at all proves nothing, so it reads `unknown`.
 * A settled row without an outcome comes from an older host and means plain completion.
 */
function turnOutcome(items: readonly AgentJournalRenderItem[]): AgentJournalTurnOutcome {
  const index = lastLifecycleIndex(items)
  const body = index === -1 ? null : items[index]!.body
  const lifecycle = body?.kind === 'status' ? body.turnLifecycle : undefined
  if (!lifecycle || lifecycle.state !== 'completed') {
    return 'unknown'
  }
  return lifecycle.outcome ?? 'completed'
}

/** Turn facts for an attached session; null when this host does not hold it. */
export function readStructuredAgentSessionTurnState(
  sessions: ReadonlyMap<
    string,
    { journal: { snapshot(): { items: readonly AgentJournalRenderItem[] } } }
  >,
  sessionId: string
): StructuredAgentSessionTurnState | null {
  const items = sessions.get(sessionId)?.journal.snapshot().items
  if (!items) {
    return null
  }
  const activeTurnId = activeStructuredAgentSessionTurnId(items)
  return {
    activeTurnId,
    lifecycleKnown: lastLifecycleIndex(items) !== -1,
    running: activeTurnId !== null,
    hasTurn: hasPersistedStructuredAgentSessionTurn(items),
    awaitingStart: awaitingTurnStart(items),
    outcome: turnOutcome(items),
    lastSequence: items.at(-1)?.sequence ?? 0
  }
}
