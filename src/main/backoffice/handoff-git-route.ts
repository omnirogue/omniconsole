import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isSafeRelativePath } from '../../shared/handoff-manifest'
import { assertValidBranchName } from '../git/checkout'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { bulkPathspecCommands } from '../git/source-control/git-pathspec'
import { publishHandoffBranch } from './handoff-git-publication'
import {
  verifyStagedHandoffFiles,
  type HandoffGitFileExpectation
} from './handoff-git-file-verification'
import {
  gitErrorText,
  handoffGit as git,
  handoffGitIsAncestor as isAncestor,
  handoffGitRead as readOptional,
  handoffRepoRoot,
  HandoffGitRouteError
} from './handoff-git-exec'

export { HandoffGitRouteError } from './handoff-git-exec'

/**
 * The git route of a handoff: the named files are committed on a handoff branch and pushed, so
 * the recipient gets them by checking the branch out instead of receiving copies.
 *
 * Built entirely with plumbing (`read-tree`, `add`, `write-tree`, `commit-tree`, `update-ref`)
 * against a throwaway index file. The person's working tree, their index and their checked-out
 * branch are never touched, so a handoff can be sent from a session that is still mid-edit.
 *
 * Replays are safe: the branch is only ever advanced. When it already exists and has work the
 * current HEAD does not contain, that tip becomes a second parent, so nothing is orphaned and
 * the push stays a fast-forward.
 */
export type HandoffGitCommit = {
  /** `owner/repo` when the remote is a GitHub URL, else the remote URL itself. */
  repo: string
  branch: string
  sha: string
  /** The branch the session was on when the handoff was made. */
  baseBranch: string | null
  remote: string
  pushed: boolean
}

export type HandoffGitRouteRequest = {
  /** The session's workspace; any directory inside the repository works. */
  worktreePath: string
  branch: string
  /** Paths relative to the repository root, as the routing rule recorded them. */
  relPaths: readonly string[]
  message: string
  options?: GitRuntimeOptions
  expectations?: readonly HandoffGitFileExpectation[]
}

/** The remote a push should go to: the current branch's remote when set, else `origin`. */
export async function resolveHandoffRemote(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const head = await readOptional(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, options)
  if (head && head !== 'HEAD') {
    const configured = await readOptional(
      ['config', '--get', `branch.${head}.remote`],
      worktreePath,
      options
    )
    if (configured) {
      return configured
    }
  }
  const remotes = (await readOptional(['remote'], worktreePath, options))?.split('\n') ?? []
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin')
}

function githubSlug(remoteUrl: string): string {
  const match =
    /^(?:git@github\.com:|(?:ssh|https?):\/\/(?:[^@/]+@)?github\.com\/)(.+?)(?:\.git)?$/.exec(
      remoteUrl
    )
  return match?.[1] ?? remoteUrl
}

/**
 * Commit the named files onto the handoff branch and push it. Returns the recorded sha, which is
 * what the manifest and the memo carry; the caller saves it before telling anyone about it.
 */
export async function commitHandoffFilesToBranch(
  request: HandoffGitRouteRequest
): Promise<HandoffGitCommit> {
  const { worktreePath, branch, message } = request
  const options = request.options ?? {}
  assertValidBranchName(branch)
  const relPaths = [...new Set(request.relPaths)]
  if (relPaths.length === 0) {
    throw new HandoffGitRouteError('invalid_request', 'A git handoff needs at least one file.')
  }
  // `.` is the whole working tree, which is what a mid-session handover commits; every other
  // path must still be a real relative path inside the repository.
  if (!relPaths.every((path) => path === '.' || isSafeRelativePath(path))) {
    throw new HandoffGitRouteError(
      'invalid_request',
      'Only paths inside the repository can travel by git.'
    )
  }
  const repoRoot = await handoffRepoRoot(worktreePath, options)
  const head = await readOptional(['rev-parse', 'HEAD'], repoRoot, options)
  const baseBranch = await readOptional(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, options)
  const existingTip = await readOptional(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    repoRoot,
    options
  )
  const indexFile = join(tmpdir(), `omni-handoff-${randomUUID()}.index`)
  let sha: string | null = null
  try {
    // Seed the throwaway index from HEAD, never from the branch tip.
    //
    // The commit must carry the work as it stands now. Seeding from an earlier handoff's tip
    // instead would silently revert every file changed on HEAD since that handoff but not named
    // in this one — the recipient would get stale contents with no sign anything was lost.
    const seed = head ?? existingTip
    if (seed) {
      await git(['read-tree', seed], repoRoot, options, indexFile)
    }
    try {
      for (const args of bulkPathspecCommands(['add', '--'], relPaths, repoRoot, options)) {
        await git(args, repoRoot, options, indexFile)
      }
    } catch (error) {
      throw new HandoffGitRouteError('commit_failed', gitErrorText(error))
    }
    if (request.expectations) {
      await verifyStagedHandoffFiles(repoRoot, indexFile, request.expectations, options)
    }
    const tree = await git(['write-tree'], repoRoot, options, indexFile)
    const parents: string[] = []
    if (head) {
      parents.push(head)
    }
    if (
      existingTip &&
      existingTip !== head &&
      !(head !== null && (await isAncestor(existingTip, head, repoRoot, options)))
    ) {
      parents.push(existingTip)
    }
    // A replay: the branch already carries this exact tree and nothing new has landed on HEAD
    // since. Re-pointing the ref would be harmless, but minting an empty commit per retry is not.
    if (existingTip) {
      const tipTree = await readOptional(['rev-parse', `${existingTip}^{tree}`], repoRoot, options)
      const headAlreadyIn =
        head === null || (await isAncestor(head, existingTip, repoRoot, options))
      if (tipTree === tree && headAlreadyIn) {
        sha = existingTip
      }
    }
    if (!sha) {
      try {
        sha = await git(
          ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message],
          repoRoot,
          options
        )
        await git(
          [
            'update-ref',
            '-m',
            'omniconsole handoff',
            `refs/heads/${branch}`,
            sha,
            existingTip ?? '0'.repeat(sha.length)
          ],
          repoRoot,
          options
        )
      } catch (error) {
        throw new HandoffGitRouteError('commit_failed', gitErrorText(error))
      }
    }
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined)
  }
  const remote = await resolveHandoffRemote(repoRoot, options)
  const remoteUrl = await readOptional(['remote', 'get-url', remote], repoRoot, options)
  await publishHandoffBranch({ repoRoot, remote, fetchUrl: remoteUrl, branch, sha, options })
  return {
    repo: remoteUrl ? githubSlug(remoteUrl) : remote,
    branch,
    sha,
    baseBranch: baseBranch === 'HEAD' ? null : baseBranch,
    remote,
    pushed: true
  }
}
