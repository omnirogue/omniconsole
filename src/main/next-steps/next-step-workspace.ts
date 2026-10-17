/**
 * Which workspace a conversation's suggester call runs in, and the ONE key for it: the scheduler
 * lane (one call per workspace at a time) and the cancel owner (only that call may cancel) are
 * both this key, so they can never disagree about which calls share a workspace.
 */

import { isGitRepoKind } from '../../shared/repo-kind'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { Store } from '../persistence'

export type NextStepWorkspace = { path: string; connectionId?: string; git: boolean }

/** Where the workspace lives on its host. Null when this host does not hold it. */
export function resolveNextStepWorkspace(
  store: Pick<Store, 'getRepo' | 'getFolderWorkspaces'>,
  worktreeId: string
): NextStepWorkspace | null {
  const folder = store.getFolderWorkspaces().find((workspace) => workspace.id === worktreeId)
  if (folder) {
    return {
      path: folder.folderPath,
      ...(folder.connectionId ? { connectionId: folder.connectionId } : {}),
      git: false
    }
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repo = parsed ? store.getRepo(parsed.repoId) : undefined
  if (!parsed || !repo) {
    return null
  }
  return {
    path: parsed.worktreePath,
    ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
    git: isGitRepoKind(repo)
  }
}

/** One suggester call per host path at a time; also the cancel-owner key. */
export function nextStepWorkspaceLane(
  workspace: Pick<NextStepWorkspace, 'path' | 'connectionId'>
): string {
  return `${workspace.connectionId ?? 'local'}\u0000${workspace.path}`
}

/**
 * The lane when this host cannot resolve the workspace: still that workspace's path, never the
 * conversation, so two conversations in one unresolved workspace still share one lane.
 */
export function nextStepFallbackLane(worktreeId: string): string {
  return nextStepWorkspaceLane({
    path: splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId
  })
}
