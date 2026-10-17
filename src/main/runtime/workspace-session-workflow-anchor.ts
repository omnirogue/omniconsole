import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

type SessionTab = WorkspaceSessionState['tabsByWorktree'][string][number]

/** A pending workflow conversation has no PTY to reconcile with host topology. */
export function isNewWorkflowAnchor(
  tab: SessionTab,
  worktreeId: string,
  existingTabIds: ReadonlySet<string>
): boolean {
  return (
    !existingTabIds.has(tab.id) &&
    tab.worktreeId === worktreeId &&
    tab.ptyId === null &&
    !tab.conversationLaunchPending &&
    ['council', 'discover', 'build-review', 'evolve'].includes(tab.localWorkflow?.preset ?? '')
  )
}
