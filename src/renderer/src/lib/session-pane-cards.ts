import type { AgentDotState } from '@/components/AgentStateDot'
import type {
  AgentPaneCard,
  AgentPaneSnapshot,
  AttentionPane
} from '@/components/attention/agent-pane-snapshot'
import type { SidebarSession } from './sidebar-sessions'

type PaneCardSnapshot = Pick<
  AgentPaneSnapshot,
  'cardsByPaneKey' | 'cardsByTabId' | 'attentionByPaneKey'
>

export function dotStateForCard(card: AgentPaneCard | undefined): AgentDotState | null {
  if (!card) {
    return null
  }
  if (card.activityUnverifiable) {
    return 'monitoring'
  }
  if (card.stopped) {
    return card.stopped
  }
  if (card.workingMode === 'monitoring') {
    return 'monitoring'
  }
  if (card.bucket === 'attention') {
    return card.dotState === 'blocked' ? 'blocked' : 'waiting'
  }
  return card.bucket === 'working' ? 'working' : card.bucket === 'done' ? 'done' : 'idle'
}

/** Acknowledging completion greys its dot; execution uncertainty still takes precedence. */
export function conversationDotStateForCard(card: AgentPaneCard | undefined): AgentDotState | null {
  if (card?.stopped) {
    return card.stopped
  }
  return card?.dotState === 'done' && !card.activityUnverifiable ? 'done' : dotStateForCard(card)
}

/** The pane a sidebar row reports on, and whether it is asking for a person. */
export function cardsForSession(
  session: SidebarSession,
  snapshot: PaneCardSnapshot
): { card: AgentPaneCard | undefined; attention: AttentionPane | null } {
  if (session.paneKey) {
    return {
      card: snapshot.cardsByPaneKey.get(session.paneKey),
      attention: snapshot.attentionByPaneKey.get(session.paneKey) ?? null
    }
  }
  if (!session.tabId) {
    return { card: undefined, attention: null }
  }
  // Why: a tab-level row (no leaf yet) inherits the most demanding pane of its tab.
  const tabCards = (snapshot.cardsByTabId.get(session.tabId) ?? []).filter(
    (card) => card.worktreeId === session.worktreeId
  )
  const attention = tabCards
    .map((card) => snapshot.attentionByPaneKey.get(card.paneKey) ?? null)
    .find((pane): pane is AttentionPane => pane !== null)
  return { card: tabCards[0], attention: attention ?? null }
}
