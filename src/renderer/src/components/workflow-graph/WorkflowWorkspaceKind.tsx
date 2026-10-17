import { useAppStore } from '@/store'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { WorkflowWorkspaceIsFolder } from './workflow-workspace-kind-context'

/** Whether a tab's workspace is a plain folder: a folder workspace, or a repository added as one. */
export function workflowWorkspaceIsFolder(
  repos: readonly Pick<Repo, 'id' | 'kind'>[],
  worktreeId: string
): boolean {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return true
  }
  const id = getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
  const repo = repos.find((entry) => entry.id === id)
  return repo ? isFolderRepo(repo) : false
}

/** Reads the workspace's kind from the store once, for every setting below it. */
export function WorkflowWorkspaceKindProvider({
  worktreeId,
  children
}: {
  worktreeId: string
  children: React.ReactNode
}) {
  const folder = useAppStore((state) => workflowWorkspaceIsFolder(state.repos, worktreeId))
  return (
    <WorkflowWorkspaceIsFolder.Provider value={folder}>
      {children}
    </WorkflowWorkspaceIsFolder.Provider>
  )
}
