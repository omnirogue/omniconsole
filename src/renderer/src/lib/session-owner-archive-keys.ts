import { conversationViewKey } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'

/** A freshly observed owner overrides stale viewer placement, including explicit unarchive. */
export function sessionOwnerArchiveKeys(
  local: readonly string[],
  sessions: readonly SidebarSession[]
): Set<string> {
  const keys = new Set(local)
  for (const session of sessions) {
    if (!session.ownerArchive) {
      continue
    }
    const key = conversationViewKey(session)
    if (session.ownerArchive.archived) {
      keys.add(key)
    } else {
      keys.delete(key)
    }
  }
  return keys
}
