import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getAiVaultAgentProviderSession } from './ai-vault-resume-command'

/**
 * Why: a filed tab whose agent failed to resume after an app restart has no
 * status entry, sleeping record or launchAgent. Without its recorded provider
 * session the sidebar drops its row and a saved session vanishes with no
 * logged action. Only a tab with exactly one layout pane, and only that pane,
 * may adopt it, so a split never attributes the transcript to the wrong leaf.
 */
export function tabVaultProviderSession(
  tab: Pick<TerminalTab, 'aiVaultTitle'>,
  paneKeys: readonly string[],
  paneKey: string
): { agent: string; providerSession: AgentProviderSessionMetadata } | null {
  const vault = tab.aiVaultTitle
  if (!vault?.agent || !vault.sessionId || paneKeys.length !== 1 || paneKeys[0] !== paneKey) {
    return null
  }
  const providerSession = getAiVaultAgentProviderSession(vault)
  return providerSession ? { agent: vault.agent, providerSession } : null
}
