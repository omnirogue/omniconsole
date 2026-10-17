import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../../shared/worktree/id'

export type BriefWorkspace = {
  worktreeId: string
  /** Workspace plus execution host; the brief hash and its approval bind to it. */
  workspaceKey: string
  label: string
  kind: 'git' | 'folder'
  /** Path on the workspace's own computer; null when this client cannot address it. */
  worktreePath: string | null
  connectionId?: string
  /** Paired-host sessions are created by the host, so this client cannot draft there or find the tab later. */
  paired: boolean
}

export function useBriefWorkspace(worktreeId: string | null): BriefWorkspace | null {
  const context = useAppStore(
    useShallow((state) => ({
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      sshConnectionStates: state.sshConnectionStates,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
    }))
  )
  const connectionId = useAppStore((state) =>
    worktreeId ? getConnectionIdFromState(state, worktreeId) : null
  )
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  return useMemo(() => {
    if (!worktreeId) {
      return null
    }
    const resolved = sidebarSessionWorkspace(context, worktreeId)
    const scope = parseWorkspaceKey(worktreeId)
    const owner =
      scope?.type === 'folder' ? findFolderWorkspaceOwner(context, scope.folderWorkspaceId) : null
    const folder = owner ? context.folderWorkspaces.find((item) => item === owner) : undefined
    const repo = context.repos.find((item) => item.id === getRepoIdFromWorktreeId(worktreeId))
    const sshConnection = connectionId ?? folder?.connectionId ?? null
    return {
      worktreeId,
      workspaceKey: JSON.stringify([worktreeId, resolved.hostId ?? 'local']),
      label: resolved.workspaceLabel,
      kind: folder || repo?.kind === 'folder' ? 'folder' : 'git',
      worktreePath: folder
        ? folder.folderPath
        : (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null),
      ...(sshConnection ? { connectionId: sshConnection } : {}),
      paired: isWebRuntimeSessionActive(runtimeEnvironmentId)
    }
  }, [connectionId, context, runtimeEnvironmentId, worktreeId])
}
