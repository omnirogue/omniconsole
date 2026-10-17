import type { WorkspaceSessionSnapshot } from './workspace-session'

type PendingConversationTabSnapshotFields = Pick<
  WorkspaceSessionSnapshot,
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
>

/** Pending conversation tabs have no durable session to restore. */
export function withoutPendingConversationTabs<T extends PendingConversationTabSnapshotFields>(
  snapshot: T
): T {
  const pendingTabIds = new Set<string>()
  const pendingWorktreeIds = new Set<string>()
  // A patch snapshot omits the map entirely once it empties, and the staged-browser
  // helper beside this one already reads its own optional field that way.
  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.conversationLaunchPending === true) {
        pendingTabIds.add(tab.id)
        pendingWorktreeIds.add(worktreeId)
      }
    }
  }
  if (pendingTabIds.size === 0) {
    return snapshot
  }

  const tabsByWorktree = Object.fromEntries(
    Object.entries(snapshot.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.filter((tab) => !pendingTabIds.has(tab.id))
    ])
  )

  return {
    ...snapshot,
    tabsByWorktree,
    activeTabId:
      snapshot.activeTabId && pendingTabIds.has(snapshot.activeTabId) ? null : snapshot.activeTabId,
    activeTabIdByWorktree: Object.fromEntries(
      Object.entries(snapshot.activeTabIdByWorktree).map(([worktreeId, tabId]) => [
        worktreeId,
        tabId && pendingTabIds.has(tabId) ? null : tabId
      ])
    ),
    activeTabTypeByWorktree: Object.fromEntries(
      Object.entries(snapshot.activeTabTypeByWorktree).filter(
        ([worktreeId, tabType]) =>
          tabType !== 'terminal' ||
          !pendingWorktreeIds.has(worktreeId) ||
          tabsByWorktree[worktreeId].length > 0
      )
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(snapshot.terminalLayoutsByTabId).filter(([tabId]) => !pendingTabIds.has(tabId))
    ),
    // Why: unified-tab serialization also prunes group order, recency, focus, and empty splits.
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(snapshot.unifiedTabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.filter((tab) => !(tab.contentType === 'terminal' && pendingTabIds.has(tab.entityId)))
      ])
    )
  }
}
