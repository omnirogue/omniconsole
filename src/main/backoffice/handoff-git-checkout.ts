import { assertValidBranchName } from '../git/checkout'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import {
  verifyReceivedHandoffFiles,
  type HandoffGitFileExpectation
} from './handoff-git-file-verification'
import {
  gitErrorText,
  handoffGit as git,
  handoffGitIsAncestor,
  handoffGitRead as readOptional,
  handoffRepoRoot,
  HandoffGitRouteError
} from './handoff-git-exec'

/**
 * The receive side of the git route: fetch the handoff branch and check it out in the given
 * workspace. Refuses rather than discarding local work, exactly as `git checkout` itself does.
 */
export async function checkoutHandoffBranch(input: {
  worktreePath: string
  remote: string
  branch: string
  /** The sha the sender recorded; the checkout must land on it. */
  sha: string
  options?: GitRuntimeOptions
  expectations?: readonly HandoffGitFileExpectation[]
}): Promise<{ sha: string; branch: string }> {
  const options = input.options ?? {}
  assertValidBranchName(input.branch)
  if (!/^[a-f0-9]{7,64}$/.test(input.sha)) {
    throw new HandoffGitRouteError('invalid_request', 'The handoff names no usable commit.')
  }
  const repoRoot = await handoffRepoRoot(input.worktreePath, options)
  try {
    await git(
      [
        'fetch',
        input.remote,
        `refs/heads/${input.branch}:refs/remotes/${input.remote}/${input.branch}`
      ],
      repoRoot,
      options
    )
  } catch (error) {
    throw new HandoffGitRouteError('fetch_failed', gitErrorText(error))
  }
  // `^{commit}` is what makes this a real existence check: a bare `rev-parse --verify <sha>` echoes
  // any well-formed hex string back, present or not, and the missing object only surfaces later.
  const fetched = await readOptional(
    ['rev-parse', '--verify', '--quiet', `${input.sha}^{commit}`],
    repoRoot,
    options
  )
  if (!fetched) {
    throw new HandoffGitRouteError(
      'checkout_failed',
      'The handoff commit is not in this repository after fetching.'
    )
  }
  if (input.expectations) {
    await verifyReceivedHandoffFiles(repoRoot, fetched, input.expectations, options)
  }
  // A local branch of the same name may already carry this person's own commits. `checkout -B`
  // would reset it to the handed-over sha and leave that work unreachable, so it is only used when
  // the branch does not exist or is already contained in what arrived.
  const localTip = await readOptional(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`],
    repoRoot,
    options
  )
  if (localTip && !(await handoffGitIsAncestor(localTip, fetched, repoRoot, options))) {
    throw new HandoffGitRouteError(
      'checkout_failed',
      `Your ${input.branch} has commits this handoff does not contain. Move or rename it first; nothing was changed.`
    )
  }
  try {
    await git(['checkout', '-B', input.branch, fetched, '--'], repoRoot, options)
  } catch (error) {
    throw new HandoffGitRouteError('checkout_failed', gitErrorText(error))
  }
  return { sha: fetched, branch: input.branch }
}
