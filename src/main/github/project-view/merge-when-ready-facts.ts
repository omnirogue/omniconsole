import { projectGhExecOptions, runGraphql, validateSlugArgs } from './internals'
import type {
  MergeWhenReadyCheck,
  MergeWhenReadyLabelEvent,
  MergeWhenReadyPullRequestFacts,
  MergeWhenReadyTitleEvent
} from '../../../shared/github/merge-when-ready-facts'
import type { MergeWhenReadyFactsBySlugArgs } from '../../../shared/github/project-request-types'
import type { MergeWhenReadyFactsBySlugResult } from '../../../shared/github/project-result-types'

// Why: "Merge all" reads every listed PR of a repo in one call; the cap keeps one query well
// inside GitHub's node limit and the gh output buffer.
export const MERGE_WHEN_READY_FACTS_MAX_NUMBERS = 50

type RawActor = { login?: string } | null
type RawCheck = {
  __typename?: string
  name?: string
  status?: string
  conclusion?: string | null
  context?: string
  state?: string
}
type RawEvent = {
  __typename?: string
  createdAt?: string
  actor?: RawActor
  label?: { name?: string } | null
  previousTitle?: string
  currentTitle?: string
}
type RawPullRequest = {
  number?: number
  title?: string
  body?: string | null
  state?: string
  isDraft?: boolean
  url?: string
  createdAt?: string
  author?: RawActor
  baseRefName?: string
  mergeable?: string | null
  mergeStateStatus?: string | null
  labels?: { pageInfo?: { hasNextPage?: boolean }; nodes?: ({ name?: string } | null)[] } | null
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: { contexts?: { nodes?: (RawCheck | null)[] } | null } | null
      } | null
    } | null)[]
  } | null
  timelineItems?: {
    pageInfo?: { hasPreviousPage?: boolean }
    nodes?: (RawEvent | null)[]
  } | null
}
type RawRepository = Record<string, RawPullRequest | null>

const FACTS_FRAGMENT = `fragment MergeWhenReadyFacts on PullRequest {
  number title body state isDraft url createdAt
  author { login }
  baseRefName mergeable mergeStateStatus
  labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }
  timelineItems(last: 30, itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT]) {
    pageInfo { hasPreviousPage }
    nodes {
    __typename
    ... on LabeledEvent { createdAt actor { login } label { name } }
    ... on RenamedTitleEvent { createdAt actor { login } previousTitle currentTitle }
  } }
}`

const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE'
])

/** Read-only: the box, holds, checks and merge state of up to 50 PRs in one repo. */
export async function getMergeWhenReadyFactsBySlug(
  args: MergeWhenReadyFactsBySlugArgs
): Promise<MergeWhenReadyFactsBySlugResult> {
  const slug = validateSlugArgs(args.owner, args.repo)
  if (!slug.ok) {
    return slug
  }
  const numbers = Array.isArray(args.numbers) ? [...new Set(args.numbers)] : []
  if (
    numbers.length === 0 ||
    numbers.length > MERGE_WHEN_READY_FACTS_MAX_NUMBERS ||
    !numbers.every((n) => Number.isInteger(n) && n > 0)
  ) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: `Pass 1 to ${MERGE_WHEN_READY_FACTS_MAX_NUMBERS} pull request numbers.`
      }
    }
  }
  // Why: numbers are validated integers, so inlining them as aliases cannot inject query text.
  const fields = numbers
    .map((n, i) => `pr${i}: pullRequest(number: ${n}) { ...MergeWhenReadyFacts }`)
    .join('\n')
  const result = await runGraphql<{ repository?: RawRepository | null }>(
    `query($owner:String!, $repo:String!) {
       repository(owner:$owner, name:$repo) { ${fields} }
     }
     ${FACTS_FRAGMENT}`,
    { owner: args.owner, repo: args.repo },
    projectGhExecOptions(args.host)
  )
  const repository = result.ok ? result.data.repository : partialRepository(result.raw.stdout)
  if (!repository) {
    return result.ok
      ? { ok: false, error: { type: 'not_found', message: 'Repository not found.' } }
      : { ok: false, error: result.error }
  }
  // Why: a hold label past the first page would go unseen and the PR would look ready, so a PR
  // with more labels than one page fails the read instead of being armed.
  const overflowing = numbers.find(
    (_, i) => repository[`pr${i}`]?.labels?.pageInfo?.hasNextPage === true
  )
  if (overflowing !== undefined) {
    return {
      ok: false,
      error: {
        type: 'too_large',
        message: `PR #${overflowing} has more than 100 labels, so its holds can't all be read.`
      }
    }
  }
  const pullRequests: MergeWhenReadyPullRequestFacts[] = []
  const missing: number[] = []
  numbers.forEach((number, i) => {
    const facts = mapFacts(repository[`pr${i}`])
    if (facts) {
      pullRequests.push(facts)
    } else {
      missing.push(number)
    }
  })
  return { ok: true, pullRequests, missing }
}

// Why: GitHub answers with partial data plus NOT_FOUND errors when a listed PR was deleted or
// moved; the other PRs' facts are still good, so one stale row must not fail the batch.
function partialRepository(stdout: string): RawRepository | null {
  try {
    const parsed = JSON.parse(stdout) as {
      data?: { repository?: RawRepository | null }
      errors?: { type?: string; path?: unknown[] }[]
    }
    const errors = parsed.errors ?? []
    const onlyMissingPullRequests =
      errors.length > 0 &&
      errors.every(
        (error) =>
          error.type === 'NOT_FOUND' && error.path?.length === 2 && error.path[0] === 'repository'
      )
    return onlyMissingPullRequests ? (parsed.data?.repository ?? null) : null
  } catch {
    return null
  }
}

function mapFacts(raw: RawPullRequest | null | undefined): MergeWhenReadyPullRequestFacts | null {
  if (!raw || typeof raw.number !== 'number') {
    return null
  }
  const state = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open'
  const contexts = raw.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const events = (raw.timelineItems?.nodes ?? []).filter((event): event is RawEvent => !!event)
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state,
    isDraft: raw.isDraft === true,
    url: raw.url ?? '',
    author: raw.author?.login ?? null,
    createdAt: raw.createdAt ?? '',
    baseRefName: raw.baseRefName ?? '',
    mergeable: raw.mergeable ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    labels: (raw.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : [])),
    checks: contexts.flatMap((check) => {
      const mapped = check ? mapCheck(check) : null
      return mapped ? [mapped] : []
    }),
    labelEvents: events.flatMap((event): MergeWhenReadyLabelEvent[] =>
      event.__typename === 'LabeledEvent' && event.label?.name
        ? [
            {
              label: event.label.name,
              login: event.actor?.login ?? null,
              at: event.createdAt ?? ''
            }
          ]
        : []
    ),
    titleEvents: events.flatMap((event): MergeWhenReadyTitleEvent[] =>
      event.__typename === 'RenamedTitleEvent'
        ? [
            {
              previousTitle: event.previousTitle ?? '',
              currentTitle: event.currentTitle ?? '',
              login: event.actor?.login ?? null,
              at: event.createdAt ?? ''
            }
          ]
        : []
    ),
    olderEventsOmitted: raw.timelineItems?.pageInfo?.hasPreviousPage === true
  }
}

function mapCheck(raw: RawCheck): MergeWhenReadyCheck | null {
  if (raw.__typename === 'StatusContext') {
    if (!raw.context) {
      return null
    }
    const state =
      raw.state === 'SUCCESS'
        ? 'success'
        : raw.state === 'FAILURE' || raw.state === 'ERROR'
          ? 'failure'
          : 'pending'
    return { name: raw.context, state }
  }
  if (!raw.name) {
    return null
  }
  if (raw.status !== 'COMPLETED') {
    return { name: raw.name, state: 'pending' }
  }
  const conclusion = raw.conclusion ?? ''
  const state =
    conclusion === 'SUCCESS'
      ? 'success'
      : FAILED_CONCLUSIONS.has(conclusion)
        ? 'failure'
        : 'neutral'
  return { name: raw.name, state }
}
