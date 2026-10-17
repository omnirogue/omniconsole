import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import { githubRepoReference } from '../../../../shared/github-repo-reference'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { FindOption } from './graph-find-pool'
import type { GraphCall, GraphCallView, GraphOutcome } from './graph-plan-types'

/** The seat GitHub's facts are recorded under; never an agent. */
export const GRAPH_GITHUB_SEAT_ID = 'github'
/** However large the pool, one run asks GitHub about at most this many repositories. */
const GRAPH_GITHUB_FACTS_CAP = 200

type Facts = { facts: Record<string, string>; failed: { key: string; reason: string }[] }

/**
 * The repositories a pool names, by option key; none unless at least half of the options name
 * one, so a list of ideas with a stray "and/or" is not taken for a list of repositories. An
 * option the host already fetched facts for (a GitHub search's own result) is never asked again.
 */
function repositories(pool: readonly FindOption[]) {
  const unknown = pool.filter((option) => !option.facts)
  const repos = unknown.flatMap((option) => {
    const named =
      githubRepoReference(option.title) ??
      (/github\.com\//i.test(option.detail) ? githubRepoReference(option.detail) : undefined)
    return named ? [{ key: option.key, ...named }] : []
  })
  return repos.length * 2 >= unknown.length ? repos : []
}

function readFacts(outcome: GraphOutcome): Facts & { error?: string } {
  const value = 'value' in outcome ? (outcome.value as Partial<Facts> & { error?: unknown }) : {}
  return {
    facts: value.facts ?? {},
    failed: value.failed ?? [],
    ...(typeof value.error === 'string'
      ? { error: value.error }
      : 'value' in outcome
        ? {}
        : { error: 'the fetch did not finish' })
  }
}

/**
 * A pool of repositories is judged on GitHub's facts, fetched once by the host, not on what a
 * model remembers. Returns the pool with each repository's facts, 'pending' while GitHub is
 * asked, or the pool as it was when it names no repositories (or is complete versions).
 */
export function withGitHubFacts(input: {
  findRules?: number
  judge: WorkflowStep
  pool: FindOption[]
  dependencies: string[]
  outcomes: ReadonlyMap<string, GraphOutcome>
  trail: WorkflowFindTrail
  calls: GraphCall[]
  views: GraphCallView[]
}): { pool: FindOption[]; dependencies: string[] } | 'pending' {
  // Runs admitted before facts existed replay without them, exactly as they ran.
  const named =
    (input.findRules ?? 1) < 2 || input.trail.source === 'versions' ? [] : repositories(input.pool)
  const repos = named.slice(0, GRAPH_GITHUB_FACTS_CAP)
  const notFetched = named.length - repos.length
  if (!repos.length) {
    return { pool: input.pool, dependencies: input.dependencies }
  }
  const call: GraphCall = {
    id: `${input.judge.id}/facts`,
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_GITHUB_SEAT_ID,
    dependencies: input.dependencies,
    stepId: input.judge.id,
    round: 1,
    agentIndex: input.judge.agents.length + 2,
    facts: { repos },
    validateSemantics: () => null
  }
  input.calls.push(call)
  const outcome = input.outcomes.get(call.id)
  input.views.push({
    id: call.id,
    stepId: input.judge.id,
    round: 1,
    agentIndex: call.agentIndex,
    seatId: call.seatId,
    status: outcome ? 'done' : 'ready'
  })
  if (!outcome) {
    input.trail.stage = 'facts'
    input.trail.facts = {
      repos: repos.length,
      fetched: 0,
      failed: [],
      ...(notFetched ? { notFetched } : {})
    }
    return 'pending'
  }
  const read = readFacts(outcome)
  const byKey = new Map(repos.map((entry) => [entry.key, `${entry.owner}/${entry.repo}`]))
  input.trail.facts = {
    repos: repos.length,
    fetched: Object.keys(read.facts).length,
    failed: read.failed.map((entry) => `${byKey.get(entry.key) ?? entry.key} (${entry.reason})`),
    ...(read.error ? { error: read.error } : {}),
    ...(notFetched ? { notFetched } : {})
  }
  const skipped = new Set(named.slice(GRAPH_GITHUB_FACTS_CAP).map((entry) => entry.key))
  return {
    pool: input.pool.map((option) =>
      read.facts[option.key]
        ? { ...option, facts: read.facts[option.key] }
        : skipped.has(option.key)
          ? { ...option, facts: 'not fetched: past the per-run limit' }
          : option
    ),
    dependencies: [...input.dependencies, call.id]
  }
}
