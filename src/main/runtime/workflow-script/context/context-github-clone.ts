import { acquire, ghExecFileAsync, gitExecFileAsync, release } from '../../../github/gh-utils'
import { workflowGitRefIsCommit } from '../../../../shared/workflow-context-sources'
import { WORKFLOW_CONTEXT_MAX_BYTES } from './context-copy'
import { workflowGitHubErrorText } from './context-github-errors'

const CLONE_TIMEOUT_MS = 10 * 60_000
// No prompt can wait for an answer, and large files stay as pointers.
function cloneEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
}

export type WorkflowContextClone = { commit: string }

async function gh(args: string[], options: { timeout: number; idempotent: boolean }) {
  await acquire()
  try {
    return await ghExecFileAsync(args, { host: 'github.com', env: cloneEnv(), ...options })
  } finally {
    release()
  }
}

/** GitHub's own size for the repository (its default branch's history), checked before cloning. */
async function assertRepoSize(repo: string): Promise<void> {
  const { stdout } = await gh(['api', `repos/${repo}`, '--jq', '.size'], {
    timeout: 30_000,
    idempotent: true
  })
  const kilobytes = Number(stdout.trim())
  if (Number.isFinite(kilobytes) && kilobytes * 1024 > WORKFLOW_CONTEXT_MAX_BYTES) {
    throw new Error(
      `${repo} is larger than ${Math.round(WORKFLOW_CONTEXT_MAX_BYTES / 1024 ** 3)} GB. Choose a smaller repository, or specific files from a local copy.`
    )
  }
}

/**
 * One shallow copy of `repo` at `ref` (its default branch when absent) in `target`, through the
 * GitHub CLI so private repositories work with the person's own login. A commit id is fetched by
 * id. Links are written as plain files; the caller copies the tree without `.git`.
 */
export async function cloneWorkflowContextRepo(input: {
  repo: string
  ref?: string
  target: string
}): Promise<WorkflowContextClone> {
  const { repo, ref, target } = input
  const subject = ref ? `${repo} at ${ref}` : repo
  try {
    await assertRepoSize(repo)
    const commit = !!ref && workflowGitRefIsCommit(ref)
    await gh(
      [
        'repo',
        'clone',
        repo,
        target,
        '--',
        '--depth',
        '1',
        '--config',
        'core.symlinks=false',
        ...(ref && !commit ? ['--branch', ref, '--single-branch'] : []),
        ...(commit ? ['--no-checkout'] : [])
      ],
      { timeout: CLONE_TIMEOUT_MS, idempotent: false }
    )
    if (commit) {
      // The clone's own credentials are gone once gh returns; gh answers this fetch the same way.
      await gitExecFileAsync(
        [
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!gh auth git-credential',
          'fetch',
          '--depth',
          '1',
          'origin',
          ref!
        ],
        { cwd: target, env: cloneEnv(), timeout: CLONE_TIMEOUT_MS }
      )
      await gitExecFileAsync(['checkout', '--detach', 'FETCH_HEAD'], {
        cwd: target,
        env: cloneEnv(),
        timeout: CLONE_TIMEOUT_MS
      })
    }
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: target })
    return { commit: stdout.trim() }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${repo} is larger than`)) {
      throw error
    }
    throw new Error(workflowGitHubErrorText(error, subject))
  }
}
