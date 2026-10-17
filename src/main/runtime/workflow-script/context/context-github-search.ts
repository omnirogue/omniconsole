import { acquire, ghExecFileAsync, release } from '../../../github/gh-utils'
import { workflowGitHubRepoValid } from '../../../../shared/workflow-context-sources'
import type {
  WorkflowGitHubBranchesResult,
  WorkflowGitHubRepoHit,
  WorkflowGitHubReposResult
} from '../../../../shared/workflow-context-ipc'
import { workflowGitHubErrorText } from './context-github-errors'

const LIST_FIELDS = 'nameWithOwner,description,defaultBranchRef'
const OWN_CACHE_MS = 5 * 60_000
const MAX_ORGS = 5
const DESCRIPTION_MAX = 140

type Exec = typeof ghExecFileAsync

async function gh(exec: Exec, args: string[]): Promise<string> {
  await acquire()
  try {
    return (await exec(args, { host: 'github.com', timeout: 30_000, idempotent: true })).stdout
  } finally {
    release()
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * One short line for a result row: whitespace and newlines collapsed, cut on a word boundary with
 * an ellipsis. Some repositories carry a whole README in their description.
 */
export function workflowRepoDescription(value: unknown, max = DESCRIPTION_MAX): string {
  const line = text(value).replace(/\s+/g, ' ').trim()
  if (line.length <= max) {
    return line
  }
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  // Why: a single very long word has no boundary to cut on; a hard cut still keeps one line.
  const head = space > max / 2 ? cut.slice(0, space) : cut
  return `${head.replace(/[\s.,;:!?-]+$/, '')}…`
}

/** `gh repo list` / `gh repo view` rows (nameWithOwner, defaultBranchRef.name). */
export function parseWorkflowRepoList(stdout: string): WorkflowGitHubRepoHit[] {
  const parsed = JSON.parse(stdout || '[]') as unknown
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row: Record<string, unknown>) => {
    const repo = text(row?.nameWithOwner)
    const branch = (row?.defaultBranchRef as { name?: unknown } | null)?.name
    return workflowGitHubRepoValid(repo)
      ? [
          {
            repo,
            description: workflowRepoDescription(row.description),
            defaultBranch: text(branch)
          }
        ]
      : []
  })
}

/** `gh search repos` rows (fullName, defaultBranch). */
export function parseWorkflowRepoSearch(stdout: string): WorkflowGitHubRepoHit[] {
  const parsed = JSON.parse(stdout || '[]') as unknown
  return (Array.isArray(parsed) ? parsed : []).flatMap((row: Record<string, unknown>) => {
    const repo = text(row?.fullName)
    return workflowGitHubRepoValid(repo)
      ? [
          {
            repo,
            description: workflowRepoDescription(row.description),
            defaultBranch: text(row.defaultBranch)
          }
        ]
      : []
  })
}

function unique(hits: readonly WorkflowGitHubRepoHit[]): WorkflowGitHubRepoHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = hit.repo.toLowerCase()
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

let own: { at: number; repos: Promise<WorkflowGitHubRepoHit[]> } | undefined

/** The person's own repositories and their organizations' (ApexLabs…), cached for minutes. */
function ownRepos(exec: Exec, now: number): Promise<WorkflowGitHubRepoHit[]> {
  if (own && now - own.at < OWN_CACHE_MS) {
    return own.repos
  }
  const repos = (async () => {
    const orgs = (await gh(exec, ['api', 'user/orgs', '--jq', '.[].login']).catch(() => ''))
      .split('\n')
      .map((login) => login.trim())
      .filter((login) => /^[A-Za-z0-9-]+$/.test(login))
      .slice(0, MAX_ORGS)
    const lists = await Promise.all([
      gh(exec, ['repo', 'list', '--limit', '30', '--json', LIST_FIELDS]),
      ...orgs.map((org) =>
        gh(exec, ['repo', 'list', org, '--limit', '20', '--json', LIST_FIELDS]).catch(() => '[]')
      )
    ])
    return unique(lists.flatMap(parseWorkflowRepoList))
  })()
  own = { at: now, repos }
  repos.catch(() => {
    own = undefined
  })
  return repos
}

/**
 * Repositories for the picker: with no query, the person's own and their organizations'; with
 * one, their own that match first, an exact owner/name, then GitHub's search.
 */
export async function searchWorkflowContextRepos(
  query: string,
  options: { exec?: Exec; now?: number } = {}
): Promise<WorkflowGitHubReposResult> {
  const exec = options.exec ?? ghExecFileAsync
  const words = query.trim()
  try {
    const mine = await ownRepos(exec, options.now ?? Date.now())
    if (!words) {
      return { repos: mine }
    }
    const lower = words.toLowerCase()
    const [exact, found] = await Promise.all([
      workflowGitHubRepoValid(words)
        ? gh(exec, ['repo', 'view', words, '--json', LIST_FIELDS])
            .then(parseWorkflowRepoList)
            .catch(() => [])
        : Promise.resolve([]),
      gh(exec, [
        'search',
        'repos',
        '--limit',
        '20',
        '--json',
        'fullName,description,defaultBranch',
        '--',
        words
      ]).then(parseWorkflowRepoSearch)
    ])
    const matching = mine.filter((hit) => hit.repo.toLowerCase().includes(lower))
    return { repos: unique([...exact, ...matching, ...found]).slice(0, 40) }
  } catch (error) {
    return { error: workflowGitHubErrorText(error) }
  }
}

/** All branches of `repo`, including those beyond GitHub’s first page. */
export async function listWorkflowContextBranches(
  repo: string,
  options: { exec?: Exec } = {}
): Promise<WorkflowGitHubBranchesResult> {
  if (!workflowGitHubRepoValid(repo)) {
    return { error: 'Not a GitHub owner/name.' }
  }
  try {
    const stdout = await gh(options.exec ?? ghExecFileAsync, [
      'api',
      `repos/${repo}/branches?per_page=100`,
      '--paginate',
      '--jq',
      '.[].name'
    ])
    return {
      branches: stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
  } catch (error) {
    return { error: workflowGitHubErrorText(error, repo) }
  }
}

/** Forgets the cached own-repository list (tests). */
export function resetWorkflowContextRepoCache(): void {
  own = undefined
}
