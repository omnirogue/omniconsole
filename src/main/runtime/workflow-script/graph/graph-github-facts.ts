import { createHash } from 'node:crypto'
import { acquire, extractExecError, ghExecFileAsync, release } from '../../../github/gh-utils'
import type { GraphJevOptions } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphFactsRequest, GraphOutcome } from './graph-plan-types'

export const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

type RepoJson = Record<string, unknown>

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : undefined
const day = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined

/**
 * GitHub's own `language` values (linguist's top identifiers, github.com/languages), the only
 * words the judges ever see from this field. An unrecognised value (or free text spoofing one)
 * never reaches them at all, rather than being trusted just for looking format-shaped.
 */
const KNOWN_LANGUAGES = new Set([
  'JavaScript',
  'TypeScript',
  'Python',
  'Java',
  'C',
  'C++',
  'C#',
  'Go',
  'Rust',
  'Ruby',
  'PHP',
  'Swift',
  'Kotlin',
  'Objective-C',
  'Scala',
  'Shell',
  'PowerShell',
  'HTML',
  'CSS',
  'Vue',
  'Dart',
  'Elixir',
  'Erlang',
  'Haskell',
  'Clojure',
  'Lua',
  'Perl',
  'R',
  'MATLAB',
  'Julia',
  'Zig',
  'Nim',
  'OCaml',
  'F#',
  'Assembly',
  'Solidity',
  'Groovy',
  'Vim Script',
  'Makefile',
  'Dockerfile',
  'TeX',
  'CoffeeScript',
  'Jupyter Notebook'
])
/**
 * The SPDX license identifiers github.com actually offers in its license picker, the only ones
 * the judges see; anything else (including a free-text spoof of one) is never shown.
 */
const KNOWN_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-3.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'EPL-2.0',
  'MPL-2.0',
  'Unlicense',
  'ISC',
  'Artistic-2.0',
  'WTFPL',
  'Zlib'
])

/**
 * What GitHub says about a repository, as one line the judges read. Only numbers, dates, flags
 * and the license id: never the description or topics, which the repository's owner writes and
 * could word as instructions to the judges.
 */
export function githubFactsLine(owner: string, repo: string, json: RepoJson, date: string): string {
  const fullName =
    typeof json.full_name === 'string' && FULL_NAME.test(json.full_name)
      ? json.full_name
      : `${owner}/${repo}`
  const license = (json.license as { spdx_id?: unknown } | null | undefined)?.spdx_id
  const language =
    typeof json.language === 'string' && KNOWN_LANGUAGES.has(json.language)
      ? json.language
      : undefined
  const parts = [
    count(json.stargazers_count) && `${count(json.stargazers_count)} stars`,
    count(json.forks_count) && `${count(json.forks_count)} forks`,
    count(json.open_issues_count) &&
      `${count(json.open_issues_count)} open issues and pull requests`,
    day(json.pushed_at) && `last push ${day(json.pushed_at)}`,
    day(json.created_at) && `created ${day(json.created_at)}`,
    typeof license === 'string' && KNOWN_LICENSES.has(license)
      ? `license ${license}`
      : 'no license detected',
    language && `mostly ${language}`,
    json.archived === true && 'ARCHIVED (read-only)',
    json.fork === true && 'a fork',
    fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase() && `moved to ${fullName}`
  ].filter((part): part is string => typeof part === 'string' && part.length > 0)
  return `GitHub facts for ${fullName} (fetched ${date}): ${parts.join(' · ')}`
}

/** Why one repository has no facts, in words: gh's own error is kept short. */
function failure(error: unknown): string {
  const { stderr } = extractExecError(error)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return 'the GitHub CLI (gh) is not installed'
  }
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return 'not found on GitHub'
  }
  if (/HTTP 401|gh auth login|not logged/i.test(stderr)) {
    return 'the GitHub CLI is not signed in'
  }
  const line = stderr.trim().split('\n')[0]?.trim()
  return (line || (error instanceof Error ? error.message : String(error))).slice(0, 160)
}

export type GitHubFactsResult = {
  facts: Record<string, string>
  failed: { key: string; reason: string }[]
}

/** Every repository's facts, four at a time with the app's other GitHub work; a miss is named. */
export async function fetchGitHubFacts(
  request: GraphFactsRequest,
  options: { signal?: AbortSignal; exec?: typeof ghExecFileAsync; now?: () => Date } = {}
): Promise<GitHubFactsResult> {
  const exec = options.exec ?? ghExecFileAsync
  const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10)
  const result: GitHubFactsResult = { facts: {}, failed: [] }
  await Promise.all(
    request.repos.map(async ({ key, owner, repo }) => {
      await acquire(options.signal)
      try {
        const { stdout } = await exec(['api', `repos/${owner}/${repo}`], {
          // The options name github.com repositories; a GH_HOST for a company server must not
          // answer for them with a same-named repository of its own.
          host: 'github.com',
          timeout: 20_000,
          idempotent: true,
          ...(options.signal ? { signal: options.signal } : {})
        })
        result.facts[key] = githubFactsLine(owner, repo, JSON.parse(stdout) as RepoJson, date)
      } catch (error) {
        result.failed.push({ key, reason: failure(error) })
      } finally {
        release()
      }
    })
  )
  // The order fetches finish in is not the pool's order; the record must not depend on it.
  result.failed.sort((left, right) => left.key.localeCompare(right.key))
  return result
}

/**
 * The `GraphConfig.fetchFacts` of one run: fetched once and kept, so a replay reads the same
 * facts and never asks GitHub again. A run with no facts at all keeps why, and goes on without.
 */
export function createGraphGitHubFacts(
  options: GraphJevOptions & { fetch?: typeof fetchGitHubFacts; signal?: AbortSignal }
) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.facts!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`GitHub facts are not recorded: ${call.id}`)
    }
    const result = await (options.fetch ?? fetchGitHubFacts)(
      request,
      options.signal ? { signal: options.signal } : {}
    )
    const fetched = Object.keys(result.facts).length
    const none = !fetched && result.failed.length ? result.failed[0]!.reason : undefined
    const outcome: GraphOutcome = {
      value: {
        markdown: none
          ? `GitHub facts were not fetched: ${none}.`
          : `GitHub facts for ${fetched} of ${request.repos.length} repositories.`,
        facts: result.facts,
        failed: result.failed,
        ...(none ? { error: none } : {})
      }
    }
    options.store.write(call.id, { digest, outcome, at: Date.now() })
    if (none) {
      options.log?.(`GitHub facts were not fetched: ${none}.`)
    }
    return outcome
  }
}

/** One run's fetcher; its record file is opened only when a pool of repositories comes. */
export function graphGitHubFactsForExecution(
  executionId: string,
  options: Omit<GraphJevOptions, 'store'> & { signal?: AbortSignal } = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let fetcher: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    fetcher ??= createGraphGitHubFacts({
      ...options,
      store: GraphJevStore.forExecution(executionId, undefined, 'github-facts.json')
    })
    return fetcher(call)
  }
}
