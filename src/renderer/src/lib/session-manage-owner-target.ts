import type { AppState } from '@/store'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import type { SidebarSession } from './sidebar-sessions'

/** Accepted mirror ids are viewer-local; controls address the owner's original pane. */
export function pairedSessionOwnerTarget(
  state: AppState,
  session: SidebarSession
): SessionManageSidebarRow['ownerTarget'] {
  if (parseExecutionHostId(session.hostId)?.kind !== 'runtime') {
    return undefined
  }
  const tabId = state.tabsByWorktree[session.worktreeId]?.find(
    (tab) => tab.id === session.tabId
  )?.runtimeOwnerTabId
  if (!tabId) {
    return undefined
  }
  const leafId = session.paneKey ? parsePaneKey(session.paneKey)?.leafId : undefined
  return { tabId, paneKey: leafId ? makePaneKey(tabId, leafId) : null }
}
