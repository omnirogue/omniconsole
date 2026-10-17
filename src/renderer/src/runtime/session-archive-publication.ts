import type { AppState } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { buildPaneSessions } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import { selectSidebarSessionStatus } from '@/lib/sidebar-session-status-projection'
import type { SessionArchiveProjection } from '../../../shared/session-archive-projection'

const visible: SessionArchiveProjection = { archived: false, byHand: false }
const automatic: SessionArchiveProjection = { archived: true, byHand: false }
const manual: SessionArchiveProjection = { archived: true, byHand: true }
let previous: unknown[] = []
let publication = new Map<string, ReadonlyMap<string, SessionArchiveProjection>>()

/** Reuse the sidebar's identities; terminal liveness is not a session's archive placement. */
export function sessionArchivePublication(state: AppState) {
  const view = useSessionSidebarView.getState()
  const status = selectSidebarSessionStatus(state.agentStatusByPaneKey ?? {})
  const inputs = [
    view.loaded,
    view.archiveStorageReady,
    view.archived,
    view.view.archived,
    state.repos,
    state.worktreesByRepo,
    state.folderWorkspaces,
    state.projectGroups,
    state.sshConnectionStates,
    state.runtimeStatusByEnvironmentId,
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.terminalLayoutsByTabId,
    status,
    state.sleepingAgentSessionsByPaneKey,
    state.pendingStartupByTabId,
    state.automaticAgentResumeClaimsByTabId
  ]
  if (
    inputs.length === previous.length &&
    inputs.every((value, index) => value === previous[index])
  ) {
    return publication
  }
  previous = inputs
  publication = new Map()
  // During hydration, absence of archive data has no authority to unarchive a peer's rows.
  if (!view.loaded || !view.archiveStorageReady) {
    return publication
  }
  const byHand = new Set(view.archived)
  const byView = new Set(view.view.archived ?? [])
  for (const session of buildPaneSessions({ ...state, agentStatusByPaneKey: status })) {
    if (!session.paneKey || session.hostId !== 'local') {
      continue
    }
    const key = conversationViewKey(session)
    const archive = byHand.has(key) ? manual : byView.has(key) ? automatic : visible
    const workspace = publication.get(session.worktreeId) as
      | Map<string, SessionArchiveProjection>
      | undefined
    if (workspace) {
      workspace.set(session.paneKey, archive)
    } else {
      publication.set(session.worktreeId, new Map([[session.paneKey, archive]]))
    }
  }
  return publication
}
