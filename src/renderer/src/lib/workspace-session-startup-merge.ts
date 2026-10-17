import { pruneClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  mergeWorkspaceSessionsFromHosts,
  type HostSessionSlices
} from './workspace-session-host-split'
import { restoreLegacySshTabGroups } from './workspace-session-ssh-tab-groups'

type SessionTab = WorkspaceSessionState['tabsByWorktree'][string][number]

function isWorkflowAnchor(tab: SessionTab, worktreeId: string): boolean {
  return (
    tab.worktreeId === worktreeId &&
    tab.ptyId === null &&
    !tab.conversationLaunchPending &&
    Boolean(tab.localWorkflow)
  )
}

/**
 * Keeps the workflow conversations (Build + Review in an SSH workspace) that only the local mirror
 * records. A host partition's tab list replaces the mirror's for its workspace, and an SSH spawn
 * commit writes only the terminals it bound, so a PTY-less anchor would vanish on restart.
 * The anchor carries no process claim: its run's state comes from the Build + Review pipeline.
 */
export function retainLocalWorkflowAnchors(
  session: WorkspaceSessionState,
  slices: HostSessionSlices
): WorkspaceSessionState {
  const local = slices[LOCAL_EXECUTION_HOST_ID]
  if (!local?.tabsByWorktree) {
    return session
  }
  const closedTabs = pruneClosedTerminalTabTombstones(
    session.closedTerminalTabTombstonesByTabId,
    Date.now()
  )
  let tabsByWorktree = session.tabsByWorktree
  for (const [worktreeId, localTabs] of Object.entries(local.tabsByWorktree)) {
    const merged = tabsByWorktree[worktreeId] ?? []
    if (merged === localTabs) {
      continue
    }
    const present = new Set(merged.map((tab) => tab.id))
    const anchors = localTabs.filter(
      (tab) =>
        !present.has(tab.id) &&
        isWorkflowAnchor(tab, worktreeId) &&
        closedTabs[tab.id]?.worktreeId !== worktreeId
    )
    if (anchors.length > 0) {
      tabsByWorktree = { ...tabsByWorktree, [worktreeId]: [...merged, ...anchors] }
    }
  }
  return tabsByWorktree === session.tabsByWorktree ? session : { ...session, tabsByWorktree }
}

/** The session startup restores: every host partition merged over the local mirror. */
export function mergeStartupWorkspaceSessions(slices: HostSessionSlices): WorkspaceSessionState {
  return retainLocalWorkflowAnchors(
    restoreLegacySshTabGroups(mergeWorkspaceSessionsFromHosts(slices), slices),
    slices
  )
}
