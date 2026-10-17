import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { NextStepReplyDecision } from '../../../../shared/next-step-suggestions-rpc'
import { matchesNextStepReplyPtyProof } from '../../../../shared/next-step-reply-proof'
import { nextStepReplyDecision } from '../../../../shared/next-step-reply-decision'
import type { ProjectedReplyDecision } from './remote-reply-decisions'

/** Receiver state is a stability fence, never a clock comparable to the owner's turn. */
export function replyDecisionEntryFingerprint(entry: AgentStatusEntry): string {
  return JSON.stringify([
    entry.paneKey,
    entry.worktreeId,
    entry.tabId,
    entry.connectionId,
    entry.terminalHandle,
    entry.agentType,
    entry.providerSession?.key,
    entry.providerSession?.id,
    entry.state,
    entry.stateStartedAt,
    entry.acceptedStatusSeq,
    entry.observation,
    entry.prompt,
    entry.failed,
    entry.interrupted,
    entry.sessionBoundary,
    entry.lastAssistantMessageIsToolOutput,
    entry.lastAssistantMessage
  ])
}

function localSourceFingerprint(
  state: Partial<AppState>,
  paneKey: string,
  worktreeId: string
): string | null {
  const entry = state.agentStatusByPaneKey?.[paneKey]
  const tab = state.unifiedTabsByWorktree?.[worktreeId]?.find((item) => item.id === entry?.tabId)
  return entry &&
    entry.state === 'done' &&
    entry.worktreeId === worktreeId &&
    (!tab || tab.contentType === 'terminal') &&
    !entry.connectionId &&
    (!tab?.executionHostId || tab.executionHostId === 'local')
    ? JSON.stringify([replyDecisionEntryFingerprint(entry), tab?.entityId, tab?.executionHostId])
    : null
}

export function captureLocalReplyDecisionSources(state: Partial<AppState>): Map<string, string> {
  const captured = new Map<string, string>()
  for (const entry of Object.values(state.agentStatusByPaneKey ?? {})) {
    if (
      !entry.worktreeId ||
      !entry.providerSession?.id ||
      !nextStepReplyDecision(entry.lastAssistantMessage ?? '')
    ) {
      continue
    }
    const fingerprint = localSourceFingerprint(state, entry.paneKey, entry.worktreeId)
    if (fingerprint) {
      captured.set(entry.paneKey, fingerprint)
    }
  }
  return captured
}

export function isLocalReplyDecisionCurrent(
  decision: ProjectedReplyDecision,
  state: Partial<AppState>
): boolean {
  const entry = state.agentStatusByPaneKey?.[decision.conversation.paneKey]
  const proof = decision.ptyProof
  return Boolean(
    entry &&
    proof &&
    proof.turnKey === decision.turnKey &&
    decision.localSourceFingerprint &&
    localSourceFingerprint(
      state,
      decision.conversation.paneKey,
      decision.conversation.worktreeId
    ) === decision.localSourceFingerprint &&
    matchesNextStepReplyPtyProof(proof, entry)
  )
}

export function projectLocalReplyDecisions(
  decisions: readonly NextStepReplyDecision[],
  captured: ReadonlyMap<string, string>,
  state: Partial<AppState>
): ProjectedReplyDecision[] {
  return decisions.flatMap((decision) => {
    if (decision.conversation.kind !== 'pty') {
      return [decision]
    }
    const projected = {
      ...decision,
      localSourceFingerprint: captured.get(decision.conversation.paneKey)
    }
    return isLocalReplyDecisionCurrent(projected, state) ? [projected] : []
  })
}
