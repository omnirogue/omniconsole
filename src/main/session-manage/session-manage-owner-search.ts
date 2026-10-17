// Transcript search hits carry no pane; this joins local hits to the live sidebar rows they
// belong to, by the provider session id the pane's hook reported, else by the workspace path.

import { sessionManageHostKey } from '../../shared/session-manage-query'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionSearchHit } from '../../shared/session-search-types'

export function joinSessionSearchHitsToRows(
  hits: readonly SessionSearchHit[],
  rows: readonly SessionManageSidebarRow[],
  providerSessionIdOf: (paneKey: string) => string | null
): SessionSearchHit[] {
  const local = rows.filter(
    (row): row is SessionManageSidebarRow & { paneKey: string } =>
      row.paneKey !== null && !row.folded && sessionManageHostKey(row.hostId) === 'local'
  )
  const byProviderId = new Map<string, SessionManageSidebarRow & { paneKey: string }>()
  const withoutProviderId: (SessionManageSidebarRow & { paneKey: string })[] = []
  for (const row of local) {
    const id = providerSessionIdOf(row.paneKey)
    if (id) {
      byProviderId.set(id, row)
    } else {
      withoutProviderId.push(row)
    }
  }
  return hits.map((hit) => {
    if (hit.executionHostId !== 'local') {
      return hit
    }
    // Why path only for rows with no known id: an older transcript in the same workspace must
    // not be credited to a live pane whose own conversation is a different one.
    const row =
      byProviderId.get(hit.sessionId) ??
      (hit.cwd ? withoutProviderId.find((entry) => entry.worktreePath === hit.cwd) : undefined)
    return row ? { ...hit, paneKey: row.paneKey, tabId: row.tabId } : hit
  })
}
