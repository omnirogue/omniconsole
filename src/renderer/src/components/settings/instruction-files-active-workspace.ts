import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveFolderWorkspaceHost } from '../../../../shared/folder-workspace-execution-host'
import {
  AGENT_DETECTION_LOCAL_TARGET_KEY,
  getAgentDetectionTargetKeyForWorktree
} from '@/hooks/useAgentDetectionTarget'

/** The active workspace, local hosts only: SSH writes need a host expectation this pane does not carry. */
export type ActiveWorkspace = {
  name: string
  path: string
  /** `unresolved` means the host is not known yet; `ambiguous` means it never will be. */
  host: 'local' | 'remote' | 'unresolved' | 'ambiguous'
} | null

export function useActiveWorkspace(): ActiveWorkspace {
  const activeWorkspaceKey = useAppStore((state) => state.activeWorkspaceKey)
  const repos = useAppStore((state) => state.repos)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const getKnownWorktreeById = useAppStore((state) => state.getKnownWorktreeById)
  // Why: ownership can be inherited from the repo row or the project group; the same
  // resolver the launcher uses decides what counts as local.
  const hostKey = useAppStore((state) => {
    const key = state.activeWorkspaceKey
    const scope = key ? parseWorkspaceKey(key) : null
    // Why: the resolver takes a raw worktree id or a `folder:` key, never a `worktree:` key.
    return scope?.type === 'worktree'
      ? getAgentDetectionTargetKeyForWorktree(state, scope.worktreeId)
      : key
        ? getAgentDetectionTargetKeyForWorktree(state, key)
        : undefined
  })
  // Why: a folder whose project spans local and SSH repos stays unresolved by design.
  const ambiguous = useAppStore((state) => {
    const scope = state.activeWorkspaceKey ? parseWorkspaceKey(state.activeWorkspaceKey) : null
    return (
      scope?.type === 'folder' &&
      resolveFolderWorkspaceHost(state, scope.folderWorkspaceId).kind === 'ambiguous'
    )
  })
  return useMemo(() => {
    const scope = activeWorkspaceKey ? parseWorkspaceKey(activeWorkspaceKey) : null
    const host =
      hostKey === AGENT_DETECTION_LOCAL_TARGET_KEY
        ? ('local' as const)
        : hostKey === undefined
          ? ambiguous
            ? ('ambiguous' as const)
            : ('unresolved' as const)
          : ('remote' as const)
    if (scope?.type === 'worktree') {
      const worktree = getKnownWorktreeById(scope.worktreeId)
      if (!worktree) {
        return null
      }
      const repo = repos.find((entry) => entry.id === worktree.repoId)
      return {
        name: worktree.displayName || repo?.displayName || worktree.path,
        path: worktree.path,
        host
      }
    }
    if (scope?.type === 'folder') {
      const folder = folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
      return folder ? { name: folder.name, path: folder.folderPath, host } : null
    }
    return null
  }, [activeWorkspaceKey, hostKey, ambiguous, repos, folderWorkspaces, getKnownWorktreeById])
}
