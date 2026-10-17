import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowFind, WorkflowStep } from '../../../../shared/workflow-graph'
import { GRAPH_GITHUB_SEAT_ID } from './graph-find-facts'
import type { FindOption } from './graph-find-pool'
import type { GraphHarvestAnswer } from './graph-github-harvest'
import type { GraphCall, GraphCallView, GraphOutcome } from './graph-plan-types'

/** The seat harvested repositories are recorded under: no judge's own work, so all may vote. */
export const FIND_HARVEST_SEAT = 'github-search'

export type FindHarvest = { options: FindOption[]; dependencies: string[] }

function answerOf(outcome: GraphOutcome): Partial<GraphHarvestAnswer> {
  return 'value' in outcome ? (outcome.value as Partial<GraphHarvestAnswer>) : {}
}

/**
 * The person's GitHub search as options: the host runs it once, and every repository it found
 * joins the pool as a candidate with the host's own facts. Its title is the owner/name GitHub
 * returned and its detail is empty, so nothing the repository's owner wrote can reach a judge.
 * 'pending' while GitHub is being asked; an empty result set is never taken for a search.
 */
export function withGitHubHarvest(input: {
  find: WorkflowFind
  findRules?: number
  options: WorkflowStep
  outcomes: ReadonlyMap<string, GraphOutcome>
  trail: WorkflowFindTrail
  calls: GraphCall[]
  views: GraphCallView[]
}): FindHarvest | 'pending' {
  // Runs admitted before the search existed replay without it, exactly as they ran.
  const harvest = (input.findRules ?? 0) >= 5 ? input.find.harvest : undefined
  if (!harvest || input.find.versions) {
    return { options: [], dependencies: [] }
  }
  const call: GraphCall = {
    id: `${input.options.id}/harvest`,
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_GITHUB_SEAT_ID,
    dependencies: [],
    stepId: input.options.id,
    round: 1,
    agentIndex: input.options.agents.length + 1,
    harvest: { query: harvest.query, max: harvest.max },
    validateSemantics: () => null
  }
  input.calls.push(call)
  const outcome = input.outcomes.get(call.id)
  input.views.push({
    id: call.id,
    stepId: input.options.id,
    round: 1,
    agentIndex: call.agentIndex,
    seatId: call.seatId,
    status: outcome ? 'done' : 'ready'
  })
  if (!outcome) {
    input.trail.harvest = { query: harvest.query, found: 0, dropped: 0 }
    return 'pending'
  }
  const answer = answerOf(outcome)
  const repos = answer.repos ?? []
  input.trail.harvest = {
    query: harvest.query,
    found: repos.length,
    dropped: answer.dropped ?? 0,
    ...(typeof answer.error === 'string'
      ? { error: answer.error }
      : 'value' in outcome
        ? {}
        : { error: 'the search did not finish' })
  }
  return {
    options: repos.map((repo, index): FindOption => ({
      key: `github.${index + 1}`,
      title: repo.title,
      detail: '',
      url: repo.url,
      facts: repo.facts,
      seatId: FIND_HARVEST_SEAT,
      by: 'GitHub search'
    })),
    dependencies: [call.id]
  }
}
