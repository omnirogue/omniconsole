import { createHash } from 'node:crypto'
import {
  jevRank,
  JEV_SCORE_LEVELS,
  type JevRankOptions,
  type JevRanking
} from '../../../structured-decisions/jev-rank'
import type { GraphCall, GraphJevRequest, GraphOutcome } from './graph-plan-types'
import { GraphJevStore } from './graph-jev-store'
import { criterionLeaderLines } from './graph-jev-criteria'
import { contractPolicy } from './graph-decision-rules'

export type GraphJevOptions = JevRankOptions & {
  store: GraphJevStore
  /** Only what the store already holds: recovery replays ballots and never asks JEV. */
  cacheOnly?: boolean
  log?: (message: string) => void
}

/**
 * What a kept ballot holds beyond its markdown, for calibration only: the scores and JEV's
 * certainty behind the ranking. No workflow decision reads it; ballots kept before it have none.
 */
export type GraphJevJudgment = Pick<
  JevRanking,
  'method' | 'model' | 'order' | 'scores' | 'certainty' | 'pairs' | 'usage' | 'calls'
> & {
  criteria?: JevRanking['criteria']
  unsureReason?: string
  /** Wall-clock time of the JEV calls behind the ballot, for the judging record. */
  durationMs?: number
}

function judgmentOf(ranking: JevRanking, durationMs: number): GraphJevJudgment {
  return {
    method: ranking.method,
    model: ranking.model,
    order: ranking.order,
    scores: ranking.scores,
    ...(ranking.certainty ? { certainty: ranking.certainty } : {}),
    ...(ranking.criteria.length ? { criteria: ranking.criteria } : {}),
    ...(ranking.pairs ? { pairs: ranking.pairs } : {}),
    ...(ranking.usage ? { usage: ranking.usage } : {}),
    ...(ranking.unsureReason ? { unsureReason: ranking.unsureReason } : {}),
    calls: ranking.calls,
    durationMs
  }
}

/** JEV's ranking in the ballot contract every Rank step reads (graph-parse.ts). */
function ballotMarkdown(request: GraphJevRequest, ranking: JevRanking): string {
  const labels = request.candidates.map((candidate) => candidate.label)
  const describe = (label: string) =>
    ranking.method === 'rubric'
      ? [
          `${ranking.scores[label]!.toFixed(2)} of ${JEV_SCORE_LEVELS.length - 1}`,
          ...ranking.criteria
            .filter((criterion) => criterion.scores[label] !== undefined)
            .map((criterion) => `${criterion.label} ${criterion.scores[label]!.toFixed(1)}`)
        ].join(' · ')
      : `won ${(ranking.scores[label]! * 100).toFixed(0)}% of its comparisons`
  const notes = [
    ...(ranking.method === 'rubric'
      ? criterionLeaderLines(
          labels,
          ranking.criteria,
          labels.map((label) => ranking.criteria.map((criterion) => criterion.scores[label]))
        )
      : []),
    ...(ranking.method === 'pairwise' && ranking.drivers?.length
      ? [
          `The comparisons most often turned on: ${ranking.drivers
            .slice(0, 3)
            .map((driver) => `${driver.label} (${driver.comparisons})`)
            .join(', ')}.`
        ]
      : []),
    ...(ranking.unsure ? [`JEV was not sure: ${ranking.unsureReason}.`] : [])
  ]
  return [
    ranking.method === 'rubric'
      ? `JEV rubric scores (${ranking.model}), overall then per criterion:`
      : `JEV pairwise comparisons (${ranking.model}, ${ranking.calls} judged in both orders):`,
    ...labels.map((label) => `- ${label}: ${describe(label)}`),
    '',
    ...(notes.length ? [...notes, ''] : []),
    'FINAL RANKING:',
    ...ranking.order.map((label, place) => `${place + 1}. ${label}`)
  ].join('\n')
}

/** The ballot, or why JEV could not give one. Never a partial ballot: one failed call voids it. */
export async function graphJevBallot(
  request: GraphJevRequest,
  options: JevRankOptions = {}
): Promise<{ markdown: string; unsure: boolean; judgment: GraphJevJudgment } | { failed: string }> {
  const began = Date.now()
  const ranking = await jevRank(
    {
      method: request.method,
      task: request.task,
      rubric: request.instruction,
      candidates: request.candidates.map((candidate) => ({
        id: candidate.label,
        text: candidate.markdown
      })),
      ...(request.incumbent ? { incumbent: request.incumbent } : {}),
      // Stored with the ballot, so a replay reuses the verdict this contract's thresholds gave.
      ...(request.contract
        ? { policy: contractPolicy(request.contract, ['auto', 'pairwise']) }
        : {})
    },
    { ...options, caller: 'workflow.rank' }
  )
  return 'failed' in ranking
    ? ranking
    : {
        markdown: ballotMarkdown(request, ranking),
        unsure: ranking.unsure,
        judgment: judgmentOf(ranking, Date.now() - began)
      }
}

/**
 * The `GraphConfig.judgeWithJev` of one run: a ballot is asked for once and kept, so the run
 * replays it and its view shows it. A failure is kept too, so the model judges that stood in
 * stay the ones that ranked.
 */
export function createGraphJevJudge(options: GraphJevOptions) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.jev!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`JEV ballot is not recorded: ${call.id}`)
    }
    const result = await graphJevBallot(request, options)
    // An unsure ballot still counts; with JEV first, it also calls in the model judges.
    const outcome: GraphOutcome =
      'markdown' in result
        ? {
            value: {
              markdown: result.markdown,
              ...(result.unsure ? { unsure: true } : {}),
              judgment: result.judgment
            }
          }
        : { failed: true }
    options.store.write(call.id, {
      digest,
      outcome,
      ...('failed' in result ? { detail: result.failed } : {}),
      at: Date.now()
    })
    if ('failed' in result) {
      options.log?.(`JEV could not judge ${call.stepId}: ${result.failed}.`)
    }
    return outcome
  }
}

/** One run's JEV judge; its ballot file is opened only when a JEV call actually comes. */
export function graphJevJudgeForExecution(
  executionId: string,
  options: Omit<GraphJevOptions, 'store'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let judge: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    judge ??= createGraphJevJudge({ ...options, store: GraphJevStore.forExecution(executionId) })
    return judge(call)
  }
}
