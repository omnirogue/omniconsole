import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentConversationIdentitiesEqual } from '@/store/slices/agent-conversation-identity'

/**
 * Whether two live statuses shape the same sidebar row. Only these fields decide which rows
 * exist, where they belong and what they are called; state, tool, prompt, token counts and
 * state history ping constantly and move no row.
 */
function sameRowShape(left: AgentStatusEntry, right: AgentStatusEntry): boolean {
  return (
    left.paneKey === right.paneKey &&
    left.tabId === right.tabId &&
    left.worktreeId === right.worktreeId &&
    left.connectionId === right.connectionId &&
    left.agentType === right.agentType &&
    left.terminalTitle === right.terminalTitle &&
    left.terminalResumeEligible === right.terminalResumeEligible &&
    agentProviderSessionsEqual(left.agentType, left.providerSession, right.providerSession) &&
    agentConversationIdentitiesEqual(left.conversationIdentity, right.conversationIdentity)
  )
}

let cache: { source: unknown; shared: Readonly<Record<string, AgentStatusEntry>> } | null = null

/**
 * The live status map with every row-shaping-identical entry kept at its previous identity, and
 * the whole map kept at its previous identity when none of them moved. A status ping that only
 * advanced a token count then leaves this untouched, so the sidebar's sessions are not rebuilt.
 *
 * Memoised at module scope, like the pane snapshot, so every subscriber shares one projection.
 */
export function selectSidebarSessionStatus(
  source: Readonly<Record<string, AgentStatusEntry>>
): Readonly<Record<string, AgentStatusEntry>> {
  if (cache && cache.source === source) {
    return cache.shared
  }
  const previous = cache?.shared
  const keys = Object.keys(source)
  let changed = previous === undefined || Object.keys(previous).length !== keys.length
  const shared: Record<string, AgentStatusEntry> = {}
  for (const key of keys) {
    const entry = source[key]!
    const prior = previous?.[key]
    const kept = prior && sameRowShape(prior, entry) ? prior : entry
    if (kept !== prior) {
      changed = true
    }
    shared[key] = kept
  }
  const result = changed ? shared : previous!
  cache = { source, shared: result }
  return result
}

export function resetSidebarSessionStatusCacheForTest(): void {
  cache = null
}
