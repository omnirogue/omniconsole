import { createHash } from 'node:crypto'
import { acquire, extractExecError, ghExecFileAsync, release } from '../../../github/gh-utils'
import { findOptionsStep } from '../../../../shared/workflow-graph-find'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { FULL_NAME, githubFactsLine } from './graph-github-facts'
import type { GraphJevOptions } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphHarvestRequest, GraphOutcome } from './graph-plan-types'

/** GitHub's search endpoint answers at most this many repositories per page. */
const PER_PAGE = 100

/** One repository a search found, as the pool takes it: never a word its owner wrote. */
export type HarvestedRepo = { title: string; url: string; facts: string }

export type GitHubHarvestResult = {
  repos: HarvestedRepo[]
  /** Results whose `full_name` was not a real owner/name, so nothing could be trusted about them. */
  dropped: number
}

/** A search that could not run: `retryable` means the same search may well work in a minute. */
export class GitHubHarvestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GitHubHarvestError'
  }
}

// A failure that may pass on its own: nothing is kept for it, so Retry really does search again.
const TRANSIENT =
  /HTTP 5\d\d|HTTP 429|rate limit|secondary limit|abuse detection|timed? out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|unexpected EOF/i

/** Why a search found nothing, in words, and whether waiting could change the answer. */
function harvestError(error: unknown): GitHubHarvestError {
  if (error instanceof GitHubHarvestError) {
    return error
  }
  const { stderr } = extractExecError(error)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return new GitHubHarvestError('the GitHub CLI (gh) is not installed', false)
  }
  const line = stderr.trim().split('\n')[0]?.trim()
  const reason = (line || (error instanceof Error ? error.message : String(error))).slice(0, 160)
  // GitHub also reports primary and secondary rate limits as HTTP 403.
  if (TRANSIENT.test(stderr) || TRANSIENT.test(reason)) {
    return new GitHubHarvestError(reason, true)
  }
  if (/HTTP 401|HTTP 403|gh auth login|not logged|authentication/i.test(stderr)) {
    return new GitHubHarvestError('the GitHub CLI is not signed in to github.com', false)
  }
  if (/HTTP 422|Validation Failed/i.test(stderr)) {
    return new GitHubHarvestError('GitHub could not understand the search', false)
  }
  return new GitHubHarvestError(reason, false)
}

/** A search result becomes a candidate only when GitHub named a real owner/name for it. */
function repoOf(json: Record<string, unknown>, date: string): HarvestedRepo | undefined {
  const fullName = typeof json.full_name === 'string' ? json.full_name : ''
  if (!FULL_NAME.test(fullName)) {
    return undefined
  }
  const [owner, repo] = fullName.split('/') as [string, string]
  return {
    title: fullName,
    url: `https://github.com/${fullName}`,
    facts: githubFactsLine(owner, repo, json, date)
  }
}

/**
 * The person's GitHub search, run by the host. The query is one literal argument value to `gh`
 * (never a shell word), and only host-fetched facts come back: the owner's description, topics
 * and homepage are read by nobody, so a repository cannot word itself at the judges.
 */
export async function searchGitHubRepos(
  request: GraphHarvestRequest,
  options: { signal?: AbortSignal; exec?: typeof ghExecFileAsync; now?: () => Date } = {}
): Promise<GitHubHarvestResult> {
  const exec = options.exec ?? ghExecFileAsync
  const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10)
  const result: GitHubHarvestResult = { repos: [], dropped: 0 }
  for (let page = 1; result.repos.length + result.dropped < request.max; page++) {
    const perPage = Math.min(PER_PAGE, request.max - result.repos.length - result.dropped)
    await acquire(options.signal)
    let found: unknown[]
    try {
      const { stdout } = await exec(
        [
          'api',
          '-X',
          'GET',
          'search/repositories',
          '-f',
          `q=${request.query}`,
          '-f',
          'sort=stars',
          '-f',
          `per_page=${perPage}`,
          ...(page > 1 ? ['-f', `page=${page}`] : [])
        ],
        {
          // The person searched github.com; a GH_HOST for a company server must not answer instead.
          host: 'github.com',
          timeout: 30_000,
          idempotent: true,
          ...(options.signal ? { signal: options.signal } : {})
        }
      )
      const items = (JSON.parse(stdout) as { items?: unknown }).items
      if (!Array.isArray(items)) {
        throw new GitHubHarvestError('GitHub answered the search with no results list', false)
      }
      found = items
    } catch (error) {
      throw harvestError(error)
    } finally {
      release()
    }
    for (const item of found) {
      const repo = item && typeof item === 'object' ? repoOf(item as never, date) : undefined
      if (repo) {
        result.repos.push(repo)
      } else {
        result.dropped += 1
      }
    }
    if (found.length < perPage) {
      break
    }
  }
  return result
}

/** A search's answer as the run keeps it; `error` means it found nothing, and says why. */
export type GraphHarvestAnswer = GitHubHarvestResult & { markdown: string; error?: string }

/**
 * The `GraphConfig.harvestGitHub` of one run: searched once and kept, so a replay reads the same
 * repositories and never asks GitHub again. A failure that may pass keeps nothing at all, so the
 * run fails with a reason Retry can act on rather than recording an empty search as the answer.
 */
export function createGraphGitHubHarvest(
  options: GraphJevOptions & { search?: typeof searchGitHubRepos; signal?: AbortSignal }
) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.harvest!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`The GitHub search is not recorded: ${call.id}`)
    }
    let answer: GraphHarvestAnswer
    try {
      const found = await (options.search ?? searchGitHubRepos)(
        request,
        options.signal ? { signal: options.signal } : {}
      )
      answer = {
        ...found,
        markdown: `GitHub search found ${found.repos.length} ${found.repos.length === 1 ? 'repository' : 'repositories'}.`
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
      const failure = harvestError(error)
      if (failure.retryable) {
        throw new Error(
          `The GitHub search could not be run (${failure.message}). Retry searches again.`
        )
      }
      answer = {
        repos: [],
        dropped: 0,
        markdown: `The GitHub search found nothing: ${failure.message}.`,
        error: failure.message
      }
    }
    const outcome: GraphOutcome = { value: answer }
    options.store.write(call.id, { digest, outcome, at: Date.now() })
    if (answer.error) {
      options.log?.(`The GitHub search found nothing: ${answer.error}.`)
    }
    return outcome
  }
}

/** One run's searcher; its record file is opened only when the person asked for a search. */
export function graphGitHubHarvestForExecution(
  executionId: string,
  options: Omit<GraphJevOptions, 'store'> & { signal?: AbortSignal } = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let search: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    search ??= createGraphGitHubHarvest({
      ...options,
      store: GraphJevStore.forExecution(executionId, undefined, 'github-harvest.json')
    })
    return search(call)
  }
}

/**
 * A transient search failure keeps nothing (above), so a Find run that asked for a search and has
 * no record of it can only have stopped before the search was kept: Retry is worth offering.
 */
export function graphHarvestHasRetryableFailure(spec: WorkflowSpec, store: GraphJevStore): boolean {
  const options = spec.find?.harvest ? findOptionsStep(spec) : undefined
  return !!options && !store.read(`${options.id}/harvest`)
}
