/**
 * The opaque turn revision admission compares: derived from the latest finished turn this host
 * holds, so it moves exactly when the conversation takes a turn. A delivered prompt does not move
 * it until the agent answers, which is what keeps a second Mac's echo of the same revision out.
 */

import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ConversationSource } from '../../shared/conversation-source'
import { nextStepTurnKey } from '../../shared/next-step-suggestions-rpc'
import { sessionHostDigest } from '../../shared/session-host-identity'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'

/** Positively no turn yet: a fresh conversation still has a turn to reserve. */
export const SESSION_HOST_NO_TURN = 'turn:none'

/** Null when the host cannot establish the latest turn; admission then refuses (`turn-unknown`). */
export function sessionHostTurnRevision(turn: SessionLatestTurn): string | null {
  if (turn.known && turn.turnKey) {
    // Why a digest: turn keys are unbounded, and a revision is at most 256 characters.
    return `turn:${sessionHostDigest(turn.turnKey).slice('sha256:'.length, 'sha256:'.length + 32)}`
  }
  return turn.empty ? SESSION_HOST_NO_TURN : null
}

type LeadTurnRow = Pick<
  AgentStatusIpcPayload,
  'state' | 'workingMode' | 'turnCompletedAt' | 'sessionBoundary' | 'stateStartedAt'
>

/**
 * Next steps hold a turn in memory and, after a restart, read back only a cleanly finished one: a
 * lead turn that ended while background work ran (Sal, 2026-09-24), was skipped (interrupted,
 * failed, no reply) or got the child's all-clear names none, so every answer was refused
 * `turn-unknown`. Here only, such an ended turn is named; a lead still working stays unknown.
 */
export function withEndedLeadTurn(
  turn: SessionLatestTurn,
  source: ConversationSource,
  row: LeadTurnRow | null
): SessionLatestTurn {
  if (!turn.known || turn.turnKey || turn.empty || source.kind !== 'pty' || !row) {
    return turn
  }
  const mark =
    row.state === 'done' && !row.sessionBoundary
      ? (row.turnCompletedAt ?? row.stateStartedAt)
      : row.state === 'working' && row.workingMode === 'monitoring'
        ? row.turnCompletedAt
        : undefined
  // Why this key: it is the one next steps give the same turn when they read it.
  return typeof mark === 'number' && Number.isFinite(mark)
    ? { ...turn, turnKey: nextStepTurnKey(source.paneKey, mark) }
    : turn
}
