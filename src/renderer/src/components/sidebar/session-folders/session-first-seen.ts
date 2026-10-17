import type { SidebarSession } from '@/lib/sidebar-sessions'

// Why: a row whose own timestamps are unknown would otherwise reset its age every minute and
// sit in Conversations forever. This device remembers when it first listed each row.
const firstSeenByRowKey = new Map<string, number>()

export function rememberFirstSeen(
  sessions: readonly SidebarSession[],
  at: number
): ReadonlyMap<string, number> {
  for (const session of sessions) {
    if (!firstSeenByRowKey.has(session.rowKey)) {
      firstSeenByRowKey.set(session.rowKey, at)
    }
  }
  return firstSeenByRowKey
}
