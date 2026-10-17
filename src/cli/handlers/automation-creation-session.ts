import type { AutomationConversation } from '../../shared/automation-conversation'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

/** Provenance only: the creating chat remains independent of the schedule. */
export function automationCreationSession(
  env: NodeJS.ProcessEnv = process.env
): AutomationConversation | undefined {
  const sessionId = env.ORCA_AGENT_SESSION_ID?.trim()
  const paneKey = env.ORCA_PANE_KEY?.trim() || null
  const tabId = sessionId
    ? structuredAgentSessionTabId(sessionId)
    : ((paneKey ? parsePaneKey(paneKey)?.tabId : undefined) ?? env.ORCA_TAB_ID?.trim())
  return tabId ? { tabId, paneKey: sessionId ? null : paneKey } : undefined
}
