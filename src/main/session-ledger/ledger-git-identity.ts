import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { readGitOutput } from './ledger-commit-observer'

/** The pane's normalized remote and branch (contract §1), or nulls for a folder workspace. */
export async function readGitIdentity(
  cwd: string
): Promise<{ repo: string | null; branch: string | null }> {
  const remote = await readGitOutput(cwd, ['remote', 'get-url', 'origin'])
  const repo = remote ? normalizeGitRemoteUrl(remote) : null
  const branch = repo
    ? await readGitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    : null
  return { repo, branch }
}
