import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

/**
 * The resume checkpoint OmniConsole kept for a tab's agent pane. It outlives the
 * live status row, so it is the identity a conversation keeps after the agent
 * process exits: which agent ran here and which provider session to reopen.
 */
export function findTabSleepingAgentRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>>,
  terminalTabId: string,
  preferredPaneKey?: string | null
): SleepingAgentSessionRecord | null {
  if (preferredPaneKey && records[preferredPaneKey]) {
    return records[preferredPaneKey]
  }
  const prefix = `${terminalTabId}:`
  let newest: SleepingAgentSessionRecord | null = null
  for (const [paneKey, record] of Object.entries(records)) {
    if (
      (paneKey.startsWith(prefix) || record.tabId === terminalTabId) &&
      (!newest || record.updatedAt > newest.updatedAt)
    ) {
      newest = record
    }
  }
  return newest
}
