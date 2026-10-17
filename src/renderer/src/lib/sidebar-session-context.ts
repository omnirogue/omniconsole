import type { AppState } from '@/store'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import {
  findIndexedRepoOwner,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from './worktree-runtime-owner-index'

export type SidebarSessionContext = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'sshConnectionStates'
  | 'runtimeStatusByEnvironmentId'
>

export function sidebarSessionWorkspace(
  state: SidebarSessionContext,
  worktreeId: string,
  explicitHostId?: ExecutionHostId
): { hostId: ExecutionHostId | null; workspaceLabel: string; unavailable: boolean } {
  const scope = parseWorkspaceKey(worktreeId)
  const folderOwner =
    scope?.type === 'folder'
      ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId, explicitHostId)
      : null
  const folder = state.folderWorkspaces.find((item) => item === folderOwner)
  const worktreeOwner = explicitHostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, explicitHostId)
    : findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((item) => item === worktreeOwner)
  const known = folder || worktree || worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  // Why: an SSH project's workspaces are listed by its host, so while that host is offline the
  // workspace is missing here, yet the project still names the computer its sessions run on.
  const sshConnectionId =
    known || scope?.type === 'folder'
      ? undefined
      : findIndexedRepoOwner(state.repos, getRepoIdFromWorktreeId(worktreeId))?.connectionId?.trim()
  const hostId =
    explicitHostId ??
    (known
      ? getExecutionHostIdForWorktree(state, worktreeId)
      : sshConnectionId
        ? toSshExecutionHostId(sshConnectionId)
        : null)
  const host = parseExecutionHostId(hostId)
  const runtimeStatus =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)?.status
      : null
  const unavailable =
    !host ||
    (host.kind === 'ssh'
      ? state.sshConnectionStates.get(host.targetId)?.status !== 'connected'
      : host.kind === 'runtime'
        ? !runtimeStatus ||
          Boolean(runtimeStatus.remoteControl && runtimeStatus.remoteControl.state !== 'ready')
        : false)
  const repo = worktree ? state.repos.find((item) => item.id === worktree.repoId) : undefined
  return {
    hostId,
    workspaceLabel:
      folder?.name ??
      (worktree
        ? [repo?.displayName, worktree.displayName].filter(Boolean).join(' / ')
        : worktreeId),
    unavailable
  }
}

/** One build's workspace contexts, each worktree/host pair resolved once. */
export function sidebarWorkspaceContexts(
  state: SidebarSessionContext
): (worktreeId: string, hostId?: ExecutionHostId) => ReturnType<typeof sidebarSessionWorkspace> {
  const contexts = new Map<string, ReturnType<typeof sidebarSessionWorkspace>>()
  return (worktreeId, hostId) => {
    const key = JSON.stringify([worktreeId, hostId])
    let context = contexts.get(key)
    if (!context) {
      context = sidebarSessionWorkspace(state, worktreeId, hostId)
      contexts.set(key, context)
    }
    return context
  }
}
