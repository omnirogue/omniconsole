import { ghExecFileAsync } from '../git/runner'
import {
  resolveGitHubApiRepositoryCandidates,
  type GitHubApiRepository
} from './github-api-repository'
import { githubHostExecOptions } from './github-repository-host'
import { ghRepoExecOptions, githubRepoContext } from './github-repository-identity'

function execOptions(repoPath: string, repository: GitHubApiRepository) {
  return {
    ...ghRepoExecOptions(githubRepoContext(repoPath)),
    ...githubHostExecOptions(repository),
    timeout: 60_000
  }
}

/** Origin's fork parent and network root, which `gh pr create` targets even with no upstream remote. */
async function forkParents(
  repoPath: string,
  origin: GitHubApiRepository
): Promise<GitHubApiRepository[]> {
  const { stdout } = await ghExecFileAsync(
    [
      'api',
      `repos/${origin.owner}/${origin.repo}`,
      '--jq',
      '[.parent.full_name, .source.full_name] | map(select(. != null)) | join("\\n")'
    ],
    execOptions(repoPath, origin)
  )
  return stdout
    .split('\n')
    .map((line) => line.trim().split('/'))
    .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[0] && !!parts[1])
    .map(([owner, repo]) => ({ ...origin, owner, repo }))
}

/**
 * Open pull requests from origin's branch (its own review, in origin, upstream or origin's fork
 * parents) and into it (a stack built on it), asked explicitly with `state=open` so a newer closed
 * one never hides an older open one. Null when origin is not GitHub; throws when GitHub cannot answer.
 */
export async function openGitHubPullRequestsTouching(
  repoPath: string,
  branch: string
): Promise<{ from: number; into: number } | null> {
  const { candidates, headRepo } = await resolveGitHubApiRepositoryCandidates(repoPath)
  if (!headRepo) {
    return null
  }
  const count = async (repository: GitHubApiRepository, filter: string): Promise<number> => {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${repository.owner}/${repository.repo}/pulls?state=open&per_page=1&${filter}`],
      execOptions(repoPath, repository)
    )
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('GitHub answered without a list of pull requests')
    }
    return parsed.length
  }
  const seen = new Set<string>()
  const repositories = [...candidates, ...(await forkParents(repoPath, headRepo))].filter(
    (repository) => {
      const key = `${repository.owner}/${repository.repo}`.toLowerCase()
      return seen.has(key) ? false : (seen.add(key), true)
    }
  )
  const head = `head=${encodeURIComponent(`${headRepo.owner}:${branch}`)}`
  let from = 0
  for (const repository of repositories) {
    from += await count(repository, head)
  }
  // Why origin only: a pull request into a branch lives in the repository that holds it.
  return { from, into: await count(headRepo, `base=${encodeURIComponent(branch)}`) }
}
