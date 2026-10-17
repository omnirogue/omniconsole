import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRunProviderSession } from '../../../shared/automation-run-resume-types'
import {
  deriveProviderSessionHome,
  isAutomationRunProviderSessionAgent
} from '../../../shared/automation-run-provider-session'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The provider thread a run's pane reported through its agent hook, shaped for the
 * run record. Null until the hook names a thread, or when the pane's agent is not
 * the routine's (a pane an operator repointed at another CLI is not this routine's
 * memory) or not a resumable-by-id provider.
 */
export function selectAutomationRunProviderSession(
  entry: Pick<AgentStatusEntry, 'agentType' | 'providerSession'> | undefined,
  agentId: TuiAgent
): AutomationRunProviderSession | null {
  if (!entry?.providerSession || !isAutomationRunProviderSessionAgent(agentId)) {
    return null
  }
  if (entry.agentType && entry.agentType !== 'unknown' && entry.agentType !== agentId) {
    return null
  }
  if (entry.providerSession.key !== 'session_id') {
    return null
  }
  const transcriptPath = entry.providerSession.transcriptPath
  const home = deriveProviderSessionHome(agentId, transcriptPath)
  return {
    providerSessionId: entry.providerSession.id,
    providerSessionAgent: agentId,
    ...(transcriptPath ? { providerSessionTranscriptPath: transcriptPath } : {}),
    ...(home ? { providerSessionHome: home } : {})
  }
}
