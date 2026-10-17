import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { Tab } from '../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export function canBorrowSessionPane(
  session: SidebarSession,
  tab: Tab | undefined,
  tabHostId: ExecutionHostId | null
): boolean {
  if (
    session.kind !== 'terminal' ||
    !session.hostId ||
    session.unavailable ||
    !session.tabId ||
    tab?.contentType !== 'terminal' ||
    tab.entityId !== session.tabId ||
    tab.worktreeId !== session.worktreeId ||
    tabHostId !== session.hostId ||
    (session.paneKey !== null && parsePaneKey(session.paneKey)?.tabId !== tab.entityId)
  ) {
    return false
  }
  if (session.sessionKey === null) {
    return session.paneKey === null
  }
  try {
    const key: unknown = JSON.parse(session.sessionKey)
    return (
      Array.isArray(key) &&
      key[0] === session.hostId &&
      (key[1] === 'provider' ||
        (key[1] === 'pane' && key[2] === session.worktreeId && key[3] === session.paneKey))
    )
  } catch {
    return false
  }
}
