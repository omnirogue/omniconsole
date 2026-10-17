import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { recordGitFailureInFolder, shouldSkipGitInFolder } from '../git/non-repo-folder-verdicts'
import { listWorktreesStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  // Why: WSL distros are separate Git hosts even though their folders are locally reachable.
  const hostId = options.wslDistro ? `wsl:${options.wslDistro}` : LOCAL_EXECUTION_HOST_ID
  // Why: a deleted or non-repo root re-failed every 30s scan TTL forever (#857).
  if (await shouldSkipGitInFolder(hostId, repoPath)) {
    return { ok: false, worktrees: [] }
  }
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch (error) {
    await recordGitFailureInFolder(hostId, repoPath, error)
    return { ok: false, worktrees: [] }
  }
}
