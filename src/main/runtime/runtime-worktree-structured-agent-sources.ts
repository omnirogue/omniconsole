import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId,
  structuredAgentSessionStatusState
} from '../../shared/structured-agent-session-projection'

/** Only pass the host's live roster here; retained feed history is not execution evidence. */
export function structuredWorktreeAgentSources(summaries: readonly AgentSessionStatusSummary[]) {
  return summaries.flatMap((summary) => {
    if (!summary.status) {
      return []
    }
    const tabId = structuredAgentSessionTabId(summary.sessionId)
    const payload = {
      state: structuredAgentSessionStatusState(summary.status),
      workingMode: summary.workingMode,
      prompt: summary.latestPrompt,
      agentType: summary.agent,
      failed: summary.failed,
      interrupted: summary.interrupted
    }
    return [
      {
        structured: true as const,
        paneKey: structuredAgentSessionPaneKey(tabId, summary.sessionId),
        tabId,
        worktreeId: summary.workspaceId,
        connectionId: null,
        payload,
        ...payload,
        lastAssistantMessage: summary.lastAssistantMessage ?? null,
        toolName: summary.toolName ?? null,
        toolInput: summary.toolInput ?? null,
        interrupted: summary.interrupted ?? false,
        stateStartedAt: summary.updatedAt,
        updatedAt: summary.updatedAt,
        evidenceObservedAt: summary.updatedAt,
        structuredHostOwned: summary.hostExecutionOwned,
        restoredUnconfirmed: summary.status !== 'idle' && !summary.hostExecutionOwned
      }
    ]
  })
}
