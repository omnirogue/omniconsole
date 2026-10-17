// Per-row facts `buildSessionManageSidebarRows` reports (split out for max-lines): the workspace
// a row names, whether it is pinned, whether its pane is back at a shell, and whether this
// computer may resume it from a checkpoint.

import { findTabSleepingAgentRecord } from '@/components/native-chat/native-chat-tab-sleeping-record'
import type { AppState } from '@/store'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isPairedOwnerConversation } from './paired-owner-execution'
import type { SidebarSession } from './sidebar-sessions'

export function workspaceFacts(
  state: AppState,
  worktreeId: string
): Pick<
  SessionManageSidebarRow,
  'worktreePath' | 'repoId' | 'repoLabel' | 'branch' | 'workspaceKind'
> {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
    return {
      worktreePath: folder?.folderPath ?? null,
      repoId: null,
      repoLabel: null,
      branch: null,
      workspaceKind: 'folder'
    }
  }
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  if (!worktree) {
    return {
      worktreePath: null,
      repoId: null,
      repoLabel: null,
      branch: null,
      workspaceKind: 'unknown'
    }
  }
  const repo = state.repos.find((entry) => entry.id === worktree.repoId)
  return {
    worktreePath: worktree.path,
    repoId: worktree.repoId,
    repoLabel: repo?.displayName ?? null,
    branch: worktree.branch ? worktree.branch.replace(/^refs\/heads\//, '') : null,
    workspaceKind: 'git'
  }
}

export function isPinned(state: AppState, session: SidebarSession): boolean {
  if (state.getKnownWorktreeById?.(session.worktreeId, session.hostId ?? 'local')?.isPinned) {
    return true
  }
  if (!session.tabId) {
    return false
  }
  return (state.unifiedTabsByWorktree[session.worktreeId] ?? []).some(
    (tab) => (tab.id === session.tabId || tab.entityId === session.tabId) && tab.isPinned === true
  )
}

/** The same exit evidence the chat view's "exited" notice reads, for this exact pane. */
export function isShellForeground(state: AppState, session: SidebarSession): boolean {
  const foreground = session.paneKey
    ? state.paneForegroundAgentByPaneKey?.[session.paneKey]
    : undefined
  return foreground?.shellForeground === true && !foreground.agent
}

export function isResumable(state: AppState, session: SidebarSession): boolean {
  // Why (C4/F10): a paired OmniConsole resumes its own conversations; this computer's records of
  // them never make them resumable here. Local and direct-SSH rows keep their checkpoints.
  if (
    session.kind !== 'terminal' ||
    isPairedOwnerConversation(state.mirroredConversationOwnersByEnvironment, session)
  ) {
    return false
  }
  const records = state.sleepingAgentSessionsByPaneKey ?? {}
  if (session.paneKey && records[session.paneKey]) {
    return true
  }
  return session.tabId ? findTabSleepingAgentRecord(records, session.tabId) !== null : false
}
