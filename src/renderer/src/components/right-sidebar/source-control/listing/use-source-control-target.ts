import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { resolveFolderGitTarget, type FolderGitTarget } from '@/lib/folder-workspace-git-target'
import {
  selectFolderWorkspaceAttachedRepos,
  selectFolderWorkspaceAttachedReposStatus
} from '@/store/folder-workspaces/folder-workspace-attached-repo-actions'

const NOT_FOLDER: FolderGitTarget = { kind: 'not-folder' }
const NO_ATTACHMENTS: never[] = []

/** Git target for the active folder workspace; `not-folder` for an ordinary worktree. */
export function useFolderGitTarget(): FolderGitTarget {
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const scope = parseWorkspaceKey(activeWorkspaceKey ?? activeWorktreeId ?? '')
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : null
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const attachedRepos = useAppStore((s) =>
    folderId ? selectFolderWorkspaceAttachedRepos(s, folderId) : NO_ATTACHMENTS
  )
  const attachedReposStatus = useAppStore((s) =>
    folderId ? selectFolderWorkspaceAttachedReposStatus(s, folderId) : 'ready'
  )
  const chosenWorktreeId = useAppStore((s) =>
    folderId ? s.folderGitTargetByFolderId[folderId] : undefined
  )
  return useMemo(
    () =>
      folderId
        ? resolveFolderGitTarget({
            activeWorkspaceKey,
            activeWorktreeId,
            folderWorkspaces,
            workspaceLineageByChildKey,
            worktreeLineageById,
            worktreesByRepo,
            repos,
            attachedRepos,
            attachedReposStatus,
            chosenWorktreeId
          })
        : NOT_FOLDER,
    [
      folderId,
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo,
      repos,
      attachedRepos,
      attachedReposStatus,
      chosenWorktreeId
    ]
  )
}

/**
 * The worktree Source Control reads: the active worktree, or in a folder workspace the attached
 * repo's worktree it resolved to. Null when a folder has no usable target.
 */
export function useSourceControlTarget(): { worktreeId: string | null; worktree: Worktree | null } {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const target = useFolderGitTarget()
  if (target.kind === 'target') {
    return { worktreeId: target.worktree.id, worktree: target.worktree }
  }
  return target.kind === 'not-folder'
    ? { worktreeId: activeWorktreeId, worktree: activeWorktree }
    : { worktreeId: null, worktree: null }
}

/**
 * What git-status polling follows. A folder's attached target is polled only while its Source
 * Control is on screen; otherwise the folder itself (which has no git status) is the target.
 */
export function pickSourceControlPollingTarget(
  target: FolderGitTarget,
  sourceControlVisible: boolean,
  activeWorktreeId: string | null
): { worktreeId: string | null; hostId?: Worktree['hostId'] } {
  if (target.kind === 'not-folder' || !sourceControlVisible) {
    return { worktreeId: activeWorktreeId }
  }
  return target.kind === 'target'
    ? { worktreeId: target.worktree.id, hostId: target.worktree.hostId }
    : { worktreeId: null }
}

export function useSourceControlPollingTarget(): {
  worktreeId: string | null
  hostId?: Worktree['hostId']
} {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const visible = useAppStore((s) => s.rightSidebarOpen && s.rightSidebarTab === 'source-control')
  return pickSourceControlPollingTarget(useFolderGitTarget(), visible, activeWorktreeId)
}
