import { WORKFLOW_MAX_CRITERIA, type WorkflowStep } from '../../../../shared/workflow-graph'
import { criterionCandidatesStep } from '../../../../shared/workflow-graph-decide-fields'
import { graphLabel, type GraphStanding } from './graph-parse'
import {
  GRAPH_JEV_SEAT_ID,
  graphDoneCallIds,
  graphPlural,
  type GraphCandidate,
  type GraphStepRun
} from './graph-plan-types'
import { publishGraphStep, type GraphScope } from './graph-scope'
import { resolveCompareLine, type GraphCompareLine } from './graph-compare-line'
import { graphBriefBullets, GRAPH_DEFAULT_OPTION_RUBRIC } from './graph-triage'

const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/

/** The rubric lines a comparison judges: the frame's, else the default for options. */
export function graphCompareCriteria(frame: string | undefined): string[] {
  const lines = frame ? graphBriefBullets(frame, /\brubric\b/i) : []
  const list = lines.length >= 2 ? lines : GRAPH_DEFAULT_OPTION_RUBRIC.split('\n')
  return list.map((line) => line.replace(bullet, '')).slice(0, WORKFLOW_MAX_CRITERIA)
}

/** Every finalist's developed answer, named after the option it develops. */
function candidatesOf(scope: GraphScope, source: WorkflowStep): GraphCandidate[] {
  const output = scope.outputOf(source.id)
  const pool = scope.outputOf(source.forEach!.step)
  const items = pool.status === 'ok' ? (pool.run.items ?? []) : []
  return (output.status === 'ok' ? (output.run.texts ?? []) : []).map((text, index) => {
    const title = items.find((item) => item.key === text.itemKey)?.title ?? text.label
    return {
      label: graphLabel(index),
      seatId: text.seatId,
      name: title,
      markdown: `## ${title}\n\n${text.markdown}`,
      source: { stepId: source.id, agentIndex: text.agentIndex }
    }
  })
}

/** Mean of each settled line's tie-preserving average rank; equal means share a place. */
function meanPlaces(shown: readonly GraphCandidate[], lines: GraphStanding[][]): GraphStanding[] {
  const entries = shown.map((candidate, index) => {
    const ranks = lines.flatMap((rows) => {
      const row = rows.find((entry) => entry.label === candidate.label && entry.votes > 0)
      return row ? [row.averageRank] : []
    })
    const total = ranks.reduce((sum, rank) => sum + rank, 0)
    const averageRank = ranks.length ? Math.round((total / ranks.length) * 100) / 100 : 0
    return { label: candidate.label, candidate: index, averageRank, votes: ranks.length }
  })
  const ranked = entries.filter((entry) => entry.votes > 0)
  return entries.map((entry) => ({
    ...entry,
    place: entry.votes
      ? 1 + ranked.filter((other) => other.averageRank < entry.averageRank).length
      : ranked.length + 1
  }))
}

/** Places best first; a label only breaks ties for display. */
const byPlace = (rows: readonly GraphStanding[]) =>
  rows
    .filter((row) => row.votes > 0)
    .toSorted((left, right) => left.place - right.place || left.label.localeCompare(right.label))

/**
 * Decide's comparison: each rubric line settled by JEV in both orders, or by the step's judges
 * in both orders where JEV is unsure (graph-compare-line.ts). The overall order in round 1 is the
 * mean of the settled lines' average ranks, ties kept; an unsettled line is left out as a gap.
 */
export function runGraphCompare(scope: GraphScope, step: WorkflowStep): GraphStepRun[] {
  const source = criterionCandidatesStep(step, scope.byId)!
  const frame = scope.outputOf(step.byCriterion!.rubricFrom)
  const criteria = graphCompareCriteria(
    frame.status === 'ok' ? frame.run.texts?.[0]?.markdown : undefined
  )
  const shown = candidatesOf(scope, source)
  const lines: GraphCompareLine[] = criteria.map((line, index) =>
    resolveCompareLine(scope, step, shown, line, index)
  )
  const rounds = lines.flatMap((line) => line.runs)
  const overall: GraphStepRun = {
    stepId: step.id,
    round: 1,
    state: 'waiting',
    calls: [],
    notes: []
  }
  const first = lines[0]!
  if (first.blocked || first.runs[0]!.state === 'waiting') {
    // Inputs still settling, a required input failed, or fewer than two finalists to compare.
    const blocked = first.blocked
    const only = {
      ...overall,
      ...(blocked
        ? { state: blocked.state, ...(blocked.reason ? { reason: blocked.reason } : {}) }
        : {})
    }
    publishGraphStep(scope, step, only)
    return [only]
  }
  if (lines.some((line) => line.state === 'pending')) {
    publishGraphStep(scope, step, { ...overall, state: 'active' })
    return [{ ...overall, state: 'active' }, ...rounds]
  }
  const settled = lines.filter(
    (line) => line.state === 'settled' && byPlace(line.standings ?? []).length
  )
  overall.candidates = shown
  overall.standings = meanPlaces(
    shown,
    settled.map((line) => line.standings!)
  )
  const name = (label: string) => shown.find((entry) => entry.label === label)?.name ?? label
  overall.criteria = criteria.map((criterion, index) => {
    const line = lines[index]!
    const rows = byPlace(line.standings ?? [])
    const counted = settled.includes(line)
    return {
      criterion,
      leaders: counted ? rows.filter((row) => row.place === 1).map((row) => name(row.label)) : [],
      judgedBy: counted ? line.judgedBy : [],
      ...(counted ? {} : { unsettled: line.why ?? 'no vote counted' })
    }
  })
  const ranked = byPlace(overall.standings).map((row) => `${row.place}. ${name(row.label)}`)
  overall.texts = [
    {
      label: 'Comparison',
      name: 'Comparison by criterion',
      markdown: [
        'Leader on each rubric line (JEV compared both orders; where it was unsure, model judges ranked in both orders):',
        ...overall.criteria.map((entry) =>
          entry.unsettled
            ? `- ${entry.criterion}: not settled (${entry.unsettled}), so it is left out of the overall order`
            : `- ${entry.criterion}: ${entry.leaders.join(' and ')}${entry.leaders.length > 1 ? ' (tied)' : ''}`
        ),
        `Overall order (mean place over the settled lines, ties shared): ${ranked.join('; ')}`
      ].join('\n'),
      agentIndex: 0,
      seatId: GRAPH_JEV_SEAT_ID,
      callId: ''
    }
  ]
  const missing = lines.length - settled.length
  overall.state = !settled.length ? 'failed' : missing ? 'gaps' : 'done'
  if (missing) {
    const which = overall.criteria
      .filter((entry) => entry.unsettled)
      .map((entry) => `${entry.criterion} (${entry.unsettled})`)
      .join('; ')
    overall.reason = settled.length
      ? `${graphPlural(missing, 'rubric line')} of ${lines.length} ${missing === 1 ? 'was' : 'were'} not settled, so the overall order leaves ${missing === 1 ? 'it' : 'them'} out: ${which}.`
      : `${step.title} failed: no rubric line was settled: ${which}.`
  }
  const callIds = [...new Set(rounds.flatMap(graphDoneCallIds))].sort()
  scope.outputs.set(
    step.id,
    overall.state === 'failed'
      ? { status: 'failed', reason: overall.reason!, run: overall }
      : { status: 'ok', run: overall, callIds }
  )
  return [overall, ...rounds]
}
