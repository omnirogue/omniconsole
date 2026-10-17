/**
 * A rejected review also deletes the session's OWN git worktree and branch (Sal's decision 2,
 * OAOS-12), only when `omni session launch` created that worktree for this pane, it is the same
 * workspace it was at publish, no other session uses it, it is a git worktree (folder workspaces
 * and `~/Work` are never deleted), and it is on the branch created with it (no branch of that name
 * existed then). The remote branch goes only with positive evidence: it is origin's branch of the
 * same name (never the default or another branch it tracks), this clone pushed it into being, its
 * head is exactly the local head, and GitHub answers that no pull request is open from or into it.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ArtifactReviewSleepWorkspace } from '../../shared/artifact-review-sleep'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { openGitHubPullRequestsTouching } from '../github/github-open-pull-requests-for-branch'

export type WorkspacePurge = { removed: string[]; kept: string[] }

const LAUNCH_RECORDS_DIR = 'agent-launch-operations'

/** `omni session launch` created this worktree for exactly this pane (its placement record). */
export async function worktreeCreatedForPane(
  userDataPath: string,
  worktreeId: string,
  paneKey: string
): Promise<boolean> {
  const dir = join(userDataPath, LAUNCH_RECORDS_DIR)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        placement?: { createdWorktreeId?: string }
        terminal?: { paneKey?: string | null }
      }
      if (
        record.placement?.createdWorktreeId === worktreeId &&
        record.terminal?.paneKey === paneKey
      ) {
        return true
      }
    } catch {
      // An unreadable record proves nothing.
    }
  }
  return false
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

type RemoteBranch = { repoRoot: string; remoteBranch: string; head: string } | { keep: string }

async function repoRootOf(path: string): Promise<string> {
  const commonDir = await git(path, ['rev-parse', '--git-common-dir'])
  return dirname(isAbsolute(commonDir) ? commonDir : resolve(path, commonDir))
}

/** Read before the worktree goes: the branch config lives with it while its branch exists. */
async function remoteBranchToDelete(
  path: string,
  repoRoot: string,
  branch: string,
  head: string
): Promise<RemoteBranch> {
  const remote = await git(path, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')
  const merge = await git(path, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')
  if (!remote || remote === '.' || !merge) {
    return { keep: `no remote branch: ${branch} was never pushed` }
  }
  // Why the same name on origin only: a branch made from `origin/main` tracks main, and deleting
  // what it tracks would delete the base everyone works from.
  if (remote !== 'origin' || merge !== `refs/heads/${branch}`) {
    return {
      keep: `remote branch: ${branch} tracks ${remote}/${merge.replace(/^refs\/heads\//, '')}, not its own`
    }
  }
  const defaultRef = await git(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(
    () => ''
  )
  if (defaultRef === `refs/remotes/origin/${branch}`) {
    return { keep: `remote branch origin/${branch}: it is the default branch` }
  }
  return { repoRoot, remoteBranch: branch, head }
}

async function purgeRemoteBranch(
  target: Extract<RemoteBranch, { repoRoot: string }>,
  purge: WorkspacePurge
): Promise<void> {
  const name = `origin/${target.remoteBranch}`
  const listed = await git(target.repoRoot, [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${target.remoteBranch}`
  ]).catch(() => null)
  const remoteHead = listed?.split(/\s+/)[0] ?? ''
  if (listed === null || !remoteHead) {
    purge.kept.push(`remote branch ${name}: not found or unreachable`)
    return
  }
  if (remoteHead !== target.head) {
    purge.kept.push(`remote branch ${name}: it holds commits this session's branch does not`)
    return
  }
  // Why push provenance: a branch this clone first fetched (a shared base such as main-next checked
  // out by name) was never pushed into existence from here, whatever its name.
  const pushes = await git(target.repoRoot, [
    'reflog',
    'show',
    '--format=%gs',
    `refs/remotes/origin/${target.remoteBranch}`
  ]).catch(() => '')
  if (!pushes.split('\n').at(-1)?.startsWith('update by push')) {
    purge.kept.push(`remote branch ${name}: this computer did not create it by a push`)
    return
  }
  let open: { from: number; into: number } | null
  try {
    open = await openGitHubPullRequestsTouching(target.repoRoot, target.remoteBranch)
  } catch {
    purge.kept.push(`remote branch ${name}: could not confirm that no pull request uses it`)
    return
  }
  if (!open) {
    // Why GitHub only: other forges cannot be asked here for reviews built on the branch.
    purge.kept.push(`remote branch ${name}: its host cannot say whether a review uses it`)
    return
  }
  if (open.from > 0 || open.into > 0) {
    // Why: deleting it would close those reviews; closing one is a separate, outward action.
    purge.kept.push(
      `remote branch ${name}: a pull request is open ${open.from > 0 ? 'from' : 'into'} it`
    )
    return
  }
  await git(target.repoRoot, ['push', 'origin', '--delete', target.remoteBranch])
  purge.removed.push(`remote branch ${name}`)
}

/** The checked-out branch, '' when detached (symbolic-ref's exit 1), null when unreadable. */
async function currentBranch(path: string): Promise<string | null> {
  return git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
    (branch) => branch,
    (error: unknown) => ((error as { code?: unknown } | null)?.code === 1 ? '' : null)
  )
}

/** Only show-ref's own "not found" (exit 1) proves the branch is gone; any other error is unknown. */
async function localBranchGone(repoRoot: string, branch: string): Promise<boolean> {
  return git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => false,
    (error: unknown) => (error as { code?: unknown } | null)?.code === 1
  )
}

export async function purgeSessionWorkspace(
  runtime: Pick<OrcaRuntimeService, 'removeManagedWorktree' | 'forceDeletePreservedBranch'>,
  input: {
    worktreeId: string
    workspace: ArtifactReviewSleepWorkspace | undefined
    sharedWithAnotherSession: boolean
  }
): Promise<WorkspacePurge> {
  const purge: WorkspacePurge = { removed: [], kept: [] }
  const { workspace } = input
  if (!workspace || workspace.kind !== 'git') {
    purge.kept.push(
      `its folder ${workspace?.path ?? ''} (folder workspaces are never deleted)`.trim()
    )
    return purge
  }
  if (!workspace.createdForSession || workspace.worktreeId !== input.worktreeId) {
    purge.kept.push(`worktree ${workspace.path}: it was not created for this session`)
    return purge
  }
  if (input.sharedWithAnotherSession) {
    purge.kept.push(`worktree ${workspace.path}: another session uses it`)
    return purge
  }
  const current = await currentBranch(workspace.path)
  // Why the created branch only: removing a worktree deletes the branch it is on, so one switched
  // to a shared branch (or made before the created branch was recorded) is kept whole.
  if (current === null || (current && current !== workspace.createdBranch)) {
    purge.kept.push(
      current === null
        ? `worktree ${workspace.path}: its branch could not be read`
        : `worktree ${workspace.path}: it is on ${current}, a branch this session did not create`
    )
    return purge
  }
  const branch = current
  if (!branch) {
    purge.kept.push(`branches of ${workspace.path}: no branch is checked out`)
  }
  const repoRoot = branch ? await repoRootOf(workspace.path).catch(() => '') : ''
  const head = repoRoot
    ? await git(workspace.path, ['rev-parse', `refs/heads/${branch}`]).catch(() => '')
    : ''
  const remote: RemoteBranch =
    branch && repoRoot && head
      ? await remoteBranchToDelete(workspace.path, repoRoot, branch, head).catch(
          (error: unknown) => ({
            keep: `remote branch of ${branch}: ${error instanceof Error ? error.message : String(error)}`
          })
        )
      : { keep: '' }
  const selector = `id:${input.worktreeId}`
  const removed = await runtime.removeManagedWorktree(selector, true, false)
  purge.removed.push(`worktree ${workspace.path}`)
  if (branch && repoRoot) {
    try {
      if (removed.preservedBranch?.branchName === branch) {
        await runtime.forceDeletePreservedBranch(
          selector,
          branch,
          removed.preservedBranch.head ?? head
        )
      }
      if (await localBranchGone(repoRoot, branch)) {
        purge.removed.push(`local branch ${branch}`)
      } else {
        purge.kept.push(`local branch ${branch}: git kept it`)
      }
    } catch (error) {
      purge.kept.push(
        `local branch ${branch}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if ('repoRoot' in remote) {
    try {
      await purgeRemoteBranch(remote, purge)
    } catch (error) {
      purge.kept.push(
        `remote branch origin/${branch}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else if (remote.keep) {
    purge.kept.push(remote.keep)
  }
  return purge
}
