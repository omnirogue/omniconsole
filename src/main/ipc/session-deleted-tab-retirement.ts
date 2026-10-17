import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import {
  advanceTerminalTopologyRevision,
  hasHostAuthoritativeTerminalMembership
} from '../runtime/workspace-session-terminal-membership-authority'

type LocalWorkspaceSessionStore = {
  getWorkspaceSession(): WorkspaceSessionState
  setWorkspaceSession(session: WorkspaceSessionState): void
}

/**
 * Drop a deleted conversation's saved terminal row from the local session partition.
 *
 * Why: for a repo with a terminal topology revision, main owns saved terminal membership and
 * rebases every renderer save onto its own tab list. A delete whose tab has no live PTY kills
 * nothing on main, so the renderer's close never reaches disk and the row is hydrated again on
 * the next start. This retires it the same way main's headless close does: close the row in the
 * saved session and advance the repo's revision so stale renderer writes cannot restore it.
 * No kills here: a dormant saved ptyId is not kill authority. No flush: setWorkspaceSession
 * already schedules a save, and a batch delete must not stall main with synchronous writes.
 */
export function retireDeletedTerminalTab(
  store: LocalWorkspaceSessionStore,
  tabId: string
): boolean {
  const session = store.getWorkspaceSession()
  const worktreeIds = new Set([
    ...Object.keys(session.tabsByWorktree ?? {}),
    ...Object.keys(session.unifiedTabs ?? {})
  ])
  let next = session
  let changed = false
  for (const worktreeId of worktreeIds) {
    // Why: at revision 0 the renderer's own save already drops the row; bumping the revision
    // here would hand main authority over a repo it never claimed.
    if (!hasHostAuthoritativeTerminalMembership(next, worktreeId)) {
      continue
    }
    const result = closeTerminalTabInWorkspaceSession(next, worktreeId, tabId)
    if (result.closed) {
      next = advanceTerminalTopologyRevision(result.session, worktreeId)
      changed = true
    }
  }
  if (changed) {
    store.setWorkspaceSession(next)
  }
  return changed
}
