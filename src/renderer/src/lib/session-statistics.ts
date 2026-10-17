import { conversationViewKey } from './conversation-view'
import { sessionFolderRowState } from './session-folder-rollup'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

export type SessionStatistics = {
  needsYou: number
  working: number
  waiting: number
  doneToday: number
  idle: number
  done: number
  stopped: number
  unverifiable: number
  total: number
}

function emptyStatistics(): SessionStatistics {
  return {
    needsYou: 0,
    working: 0,
    waiting: 0,
    doneToday: 0,
    idle: 0,
    done: 0,
    stopped: 0,
    unverifiable: 0,
    total: 0
  }
}

/** Reuses sidebar classification; completion dates require the sidebar's explicit completion. */
export function sessionStatistics(
  rows: readonly SessionSidebarTreeRow[],
  now: number,
  classifications: ReadonlyMap<string, string> = new Map()
): { total: SessionStatistics; byHost: ReadonlyMap<string, SessionStatistics> } {
  const total = emptyStatistics()
  const byHost = new Map<string, SessionStatistics>()
  const seen = new Set<string>()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)

  function visit(row: SessionSidebarTreeRow): void {
    const hostId = row.session.hostId ?? 'unverifiable'
    const key = JSON.stringify([hostId, conversationViewKey(row.session)])
    if (!seen.has(key)) {
      seen.add(key)
      const host = byHost.get(hostId) ?? emptyStatistics()
      byHost.set(hostId, host)
      const classification = classifications.get(row.session.rowKey)
      const state = sessionFolderRowState(row, classification)
      const idle =
        state === null ||
        (state === 'done' &&
          !row.archived &&
          !row.completed &&
          classification !== 'completed' &&
          (row.pursuitState === 'inactive' || (!row.pursuitState && row.state === 'idle')))
      const bucket = idle ? 'idle' : state === 'cantSee' ? 'unverifiable' : state
      for (const counts of [total, host]) {
        counts.total += 1
        if (bucket) {
          counts[bucket] += 1
        }
        const at = row.completed?.at
        if (
          bucket === 'done' &&
          at !== undefined &&
          at >= start.getTime() &&
          at < end.getTime() &&
          at <= now
        ) {
          counts.doneToday += 1
        }
      }
    }
    row.children?.forEach(visit)
  }
  rows.forEach(visit)
  return { total, byHost }
}
