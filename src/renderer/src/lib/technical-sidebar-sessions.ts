import type { AgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import { conversationState, conversationStateRank } from './conversation-state'
import { cardsForSession, dotStateForCard } from './session-pane-cards'
import type { SidebarSession } from './sidebar-sessions'

export type TechnicalSidebarSessionSnapshot = Pick<
  AgentPaneSnapshot,
  'cardsByPaneKey' | 'cardsByTabId' | 'attentionByPaneKey'
>

/** A session waits when its pane key has a pending "returns at" time. */
function isWaiting(
  session: SidebarSession,
  waitingUntilByPaneKey: ReadonlyMap<string, string>
): boolean {
  return session.paneKey ? waitingUntilByPaneKey.has(session.paneKey) : false
}

function rowRank(
  session: SidebarSession,
  snapshot: TechnicalSidebarSessionSnapshot,
  waitingUntilByPaneKey: ReadonlyMap<string, string>
): number {
  const { card, attention } = cardsForSession(session, snapshot)
  return conversationStateRank(
    conversationState({
      state: dotStateForCard(card),
      needsYou: attention !== null,
      waiting: isWaiting(session, waitingUntilByPaneKey)
    })
  )
}

/**
 * Same attention-first ordering as Conversations (see compareRows in
 * session-sidebar-tree.ts): what needs a person first, then what is moving,
 * then the rest; names only break ties.
 */
export function sortTechnicalSidebarSessions(
  sessions: readonly SidebarSession[],
  snapshot: TechnicalSidebarSessionSnapshot,
  waitingUntilByPaneKey: ReadonlyMap<string, string>
): SidebarSession[] {
  return [...sessions].sort(
    (left, right) =>
      rowRank(left, snapshot, waitingUntilByPaneKey) -
        rowRank(right, snapshot, waitingUntilByPaneKey) ||
      left.workspaceLabel.localeCompare(right.workspaceLabel) ||
      left.label.localeCompare(right.label) ||
      left.rowKey.localeCompare(right.rowKey)
  )
}
