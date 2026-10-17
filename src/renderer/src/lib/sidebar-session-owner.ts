import { parsePaneKey } from '../../../shared/stable-pane-id'
import { agentStatusAuthorityObservedAt } from '../../../shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SidebarSession } from './sidebar-sessions'

/** Called only for rows sharing a host-scoped provider identity. */
export function shouldReplaceSidebarSession(
  existing: SidebarSession | undefined,
  candidate: SidebarSession,
  entries: Readonly<Record<string, AgentStatusEntry>>
): boolean {
  if (!existing) {
    return true
  }
  const observedAt = (row: SidebarSession): number => {
    const entry = row.paneKey ? entries[row.paneKey] : undefined
    return entry ? agentStatusAuthorityObservedAt(entry) : -1
  }
  // A resumed conversation must report its latest pane, not the first tab's old completion.
  return observedAt(candidate) > observedAt(existing)
}

export function indexPaneRecordsByTab<T extends { paneKey: string; tabId?: string }>(
  records: Record<string, T> | undefined
): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const record of Object.values(records ?? {})) {
    const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
    if (tabId) {
      const bucket = index.get(tabId) ?? []
      bucket.push(record)
      index.set(tabId, bucket)
    }
  }
  return index
}
