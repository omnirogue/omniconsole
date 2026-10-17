import { pruneClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import type { HostSessionSlices } from './workspace-session-host-split'

/** Host spawn records can predate the local mirror's unified tab format. */
export function restoreLegacySshTabGroups(
  session: WorkspaceSessionState,
  slices: HostSessionSlices
): WorkspaceSessionState {
  if (!session.unifiedTabs || !session.tabGroups) {
    return session
  }

  const closedTabs = pruneClosedTerminalTabTombstones(
    session.closedTerminalTabTombstonesByTabId,
    Date.now()
  )
  const legacyWorktreeIds = new Set<string>()
  const tabsByWorktree = { ...session.tabsByWorktree }
  for (const [hostId, slice] of Object.entries(slices)) {
    if (!slice || parseExecutionHostId(hostId)?.kind !== 'ssh') {
      continue
    }
    for (const [worktreeId, tabs] of Object.entries(slice.tabsByWorktree)) {
      if (
        session.tabsByWorktree[worktreeId] !== tabs ||
        Object.hasOwn(session.unifiedTabs, worktreeId) ||
        Object.hasOwn(session.tabGroups, worktreeId)
      ) {
        continue
      }
      // Absence permits migration; an explicit canonical row, even empty, does not.
      legacyWorktreeIds.add(worktreeId)
      tabsByWorktree[worktreeId] = tabs.filter(
        (tab) => !Object.hasOwn(closedTabs, tab.id) || closedTabs[tab.id].worktreeId !== worktreeId
      )
    }
  }
  if (legacyWorktreeIds.size === 0) {
    return session
  }

  const restored = buildHydratedTabState(
    { ...session, tabsByWorktree, unifiedTabs: undefined, tabGroups: undefined },
    legacyWorktreeIds
  )
  return {
    ...session,
    tabsByWorktree,
    unifiedTabs: { ...session.unifiedTabs, ...restored.unifiedTabsByWorktree },
    tabGroups: { ...session.tabGroups, ...restored.groupsByWorktree },
    tabGroupLayouts: { ...session.tabGroupLayouts, ...restored.layoutByWorktree },
    activeGroupIdByWorktree: {
      ...session.activeGroupIdByWorktree,
      ...restored.activeGroupIdByWorktree
    }
  }
}
