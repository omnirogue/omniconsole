import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'

export function structuredSessionOutcomeEnvironment(
  identity: AgentSessionJournalIdentity
): Record<string, string> {
  return {
    ORCA_AGENT_SESSION_ID: identity.sessionId,
    ORCA_WORKTREE_ID: identity.workspaceId,
    ORCA_PANE_KEY: structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(identity.sessionId),
      identity.sessionId
    ),
    // A native child must never inherit the terminal launch that started its host.
    ORCA_TERMINAL_HANDLE: '',
    ORCA_AGENT_LAUNCH_TOKEN: '',
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: '',
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: '',
    ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: '',
    ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: ''
  }
}
