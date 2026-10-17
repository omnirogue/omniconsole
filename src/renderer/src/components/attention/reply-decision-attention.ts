import { nextStepReplyDecision } from '../../../../shared/next-step-reply-decision'
import {
  isReplyDecisionOwnerCurrent,
  type ProjectedReplyDecision
} from '../next-steps/remote-reply-decisions'
import {
  compareAttentionPanes,
  type AgentPaneSnapshot,
  type AttentionPane
} from './agent-pane-snapshot'
import type { AgentPaneSnapshotInputs } from './use-agent-pane-snapshot'

/** A completed turn can still ask a question; only its owner's current reply may override Done. */
export function withReplyDecisionAttention(
  snapshot: AgentPaneSnapshot,
  decisions: readonly ProjectedReplyDecision[],
  inputs: AgentPaneSnapshotInputs
): AgentPaneSnapshot {
  const added: AttentionPane[] = []
  for (const decision of decisions) {
    const { paneKey, worktreeId } = decision.conversation
    const card = snapshot.cardsByPaneKey.get(paneKey)
    const entry = inputs.agentStatusByPaneKey[paneKey]
    const tab = inputs.unifiedTabsByWorktree[worktreeId]?.find((item) => item.id === card?.tabId)
    if (
      !card ||
      !entry ||
      card.worktreeId !== worktreeId ||
      entry.worktreeId !== worktreeId ||
      entry.state !== 'done' ||
      entry.failed ||
      entry.interrupted ||
      entry.sessionBoundary ||
      entry.lastAssistantMessageIsToolOutput ||
      nextStepReplyDecision(entry.lastAssistantMessage ?? '') !== decision.question ||
      !isReplyDecisionOwnerCurrent(decision, inputs) ||
      (!decision.remoteOwner &&
        (entry.connectionId || (tab?.executionHostId && tab.executionHostId !== 'local'))) ||
      (decision.conversation.kind !== 'pty' && entry.stateStartedAt > decision.completedAt) ||
      card.activityUnverifiable ||
      (card.dotState !== 'done' && card.dotState !== 'idle') ||
      snapshot.attentionByPaneKey.has(paneKey)
    ) {
      continue
    }
    added.push({
      ...card,
      bucket: 'attention',
      dotState: 'waiting',
      cause: 'waiting',
      portalPaneKey: paneKey,
      stateChangedAt: decision.completedAt,
      askSummary: decision.question
    })
  }
  if (!added.length) {
    return snapshot
  }
  const attention = [...snapshot.attention, ...added].sort(compareAttentionPanes)
  return {
    ...snapshot,
    attention,
    attentionByPaneKey: new Map(attention.map((pane) => [pane.paneKey, pane])),
    attentionWorktreeIds: new Set(attention.map((pane) => pane.worktreeId))
  }
}
