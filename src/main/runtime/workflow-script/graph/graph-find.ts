import { screenFindPool } from './graph-find-pool-paging'
import { keepCriterionLeaders } from './graph-find-leaders'
import { jevCriteria } from '../../../../shared/jev-rubric'
import type { WorkflowFindPick, WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import { findJudgeStep, findOptionsStep } from '../../../../shared/workflow-graph-find'
import { WORKFLOW_MAX_RANK_CANDIDATES } from '../../../../shared/workflow-graph'
import { prepareFindPool } from './graph-find-stages'
import { withGitHubHarvest } from './graph-find-harvest'
import {
  poolFromGivenItems,
  findOptionText,
  poolFromItems,
  poolFromTexts,
  type FindOption
} from './graph-find-pool'
import { findRows, type FindScreen } from './graph-find-rows'
import { graphLabel } from './graph-parse'
import {
  graphDoneCallIds,
  type GraphCandidate,
  type GraphCallView,
  type GraphStepRun
} from './graph-plan-types'
import { publishGraphStep, type GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'
import { graphScreenKeepsUnscored } from './graph-decision-rules'
import { keepUnscored } from './graph-find-unscored'

const pending = (run: GraphStepRun | undefined) =>
  !!run && (run.state === 'waiting' || run.state === 'active')

const pick = (option: FindOption, score?: number): WorkflowFindPick => ({
  key: option.key,
  title: option.title.slice(0, 300),
  detail: option.detail.slice(0, 600),
  ...(score !== undefined ? { score } : {}),
  by: option.by
})

/**
 * Find the best, one planning pass: the pool (the models' lists, or the person's), JEV's score
 * for every option, the shortlists, and the head-to-head final among the overall top options.
 * JEV screens because it is cheap enough to read every option; the final is the judge step.
 */
export function runFindBest(scope: GraphScope): void {
  const { spec } = scope.config
  const find = spec.find!
  const options = findOptionsStep(spec)!
  const judge = findJudgeStep(spec)!
  const trail: WorkflowFindTrail = {
    stage: 'options',
    pool: 0,
    source: find.items ? 'list' : find.versions ? 'versions' : 'generated',
    ...(find.importMerged !== undefined ? { importMerged: find.importMerged } : {}),
    ...(find.importReceipt ? { importReceipt: find.importReceipt } : {}),
    top: find.top,
    keep: find.keep ?? find.top,
    overall: [],
    byCriterion: []
  }
  scope.find = trail
  const fail = (reason: string) => {
    trail.stage = 'failed'
    trail.reason = reason
  }
  const noun = find.versions ? 'version' : 'option'
  // The person's own lines read in full; JEV's labels stop at five words.
  const lines = new Map(
    jevCriteria(judge.instruction).map((criterion) => [criterion.id, criterion.question])
  )
  const criterionName = (criterion: { id: string; label: string }) =>
    (/^c\d+$/.test(criterion.id) && lines.get(criterion.id)) || criterion.label

  // Planned before the options step runs, so GitHub is searched while the models are still writing.
  const harvestViews: GraphCallView[] = []
  const harvested = withGitHubHarvest({
    find,
    ...(scope.config.findRules !== undefined ? { findRules: scope.config.findRules } : {}),
    options,
    outcomes: scope.outcomes,
    trail,
    calls: scope.calls,
    views: harvestViews
  })

  let pool: FindOption[]
  let dependencies: string[] = []
  if (find.items) {
    pool = poolFromGivenItems(find.items, find.itemDetails)
    const given: GraphStepRun = {
      stepId: options.id,
      round: 1,
      state: 'empty',
      reason: 'Your own options were used.',
      calls: harvestViews,
      notes: []
    }
    scope.runs[options.id] = [given]
    publishGraphStep(scope, options, given)
  } else {
    const run = runGraphStep(scope, options, 1)
    run.calls.unshift(...harvestViews)
    scope.runs[options.id] = [run]
    publishGraphStep(scope, options, run)
    if (pending(run)) {
      return
    }
    const made = find.versions ? run.texts : run.items
    if (run.state === 'failed' || run.state === 'not-run' || !made?.length) {
      return fail(`${options.title}: ${run.reason ?? `no ${noun}s came back.`}`)
    }
    pool = find.versions
      ? poolFromTexts(scope, options, run.texts!)
      : poolFromItems(scope, options, run.items!)
    dependencies = graphDoneCallIds(run)
  }
  // The search's repositories join the pool as candidates, judged like any other option.
  if (harvested === 'pending') {
    return
  }
  pool = [...pool, ...harvested.options]
  dependencies = [...dependencies, ...harvested.dependencies]
  trail.pool = pool.length
  if (pool.length < 2) {
    return fail(`Only one ${noun} came back, so there is nothing to choose between.`)
  }

  const screenViews: GraphCallView[] = []
  const prepared = prepareFindPool({
    find,
    ...(scope.config.findRules !== undefined ? { findRules: scope.config.findRules } : {}),
    judge,
    pool,
    dependencies,
    outcomes: scope.outcomes,
    trail,
    calls: scope.calls,
    views: screenViews
  })
  if (prepared === 'pending') {
    scope.runs[judge.id] = [
      { stepId: judge.id, round: 1, state: 'active', calls: screenViews, notes: [] }
    ]
    return
  }
  ;({ pool, dependencies } = prepared)

  // Every option goes to JEV, unless all of them fit in the final.
  let finalists = pool.slice(0, find.top)
  let screen: FindScreen | undefined
  if (pool.length > find.top) {
    trail.stage = 'screen'
    const read = screenFindPool(scope, judge, pool, dependencies, screenViews)
    if (read === 'pending') {
      scope.runs[judge.id] = [
        { stepId: judge.id, round: 1, state: 'active', calls: screenViews, notes: [] }
      ]
      return
    }
    if ('error' in read) {
      scope.runs[judge.id] = [
        {
          stepId: judge.id,
          round: 1,
          state: 'failed',
          reason: read.error,
          calls: screenViews,
          notes: []
        }
      ]
      return fail(`JEV could not screen the ${pool.length} ${noun}s: ${read.error}.`)
    }
    screen = read
    const scored = pool.filter((option) => read.scores[option.key] !== undefined)
    trail.scored = scored.length
    trail.unscored = pool.length - scored.length
    const best = (score: (option: FindOption) => number) =>
      [...scored].sort(
        (left, right) => score(right) - score(left) || pool.indexOf(left) - pool.indexOf(right)
      )
    finalists = best((option) => read.scores[option.key]!).slice(0, find.top)
    // Shortlists per rubric line only for the person's own lines, not the general ones.
    if (jevCriteria(judge.instruction).some((criterion) => /^c\d+$/.test(criterion.id))) {
      trail.byCriterion = read.criteria.map((criterion) => ({
        criterion: criterionName(criterion),
        picks: best((option) => criterion.scores[option.key] ?? -1)
          .slice(0, find.top)
          .map((option) => pick(option, criterion.scores[option.key]))
      }))
    }
  }
  if (screen && (scope.config.findRules ?? 0) >= 3) {
    finalists = keepCriterionLeaders(
      pool,
      finalists,
      screen,
      trail,
      criterionName,
      Math.max(find.top, WORKFLOW_MAX_RANK_CANDIDATES)
    )
  }
  const keepsUnscored = !!screen && graphScreenKeepsUnscored(scope.config, `${judge.id}/screen`)
  if (keepsUnscored) {
    finalists = keepUnscored(pool, finalists, screen!, trail)
  }
  trail.overall = finalists.map((option) => pick(option, screen?.scores[option.key]))

  const decide = (
    winner: FindOption,
    decidedBy: WorkflowFindTrail['decidedBy'],
    places: ReadonlyMap<string, number> = new Map()
  ) => {
    trail.winner = pick(winner, screen?.scores[winner.key])
    trail.decidedBy = decidedBy
    trail.criteria = screen?.criteria.map(criterionName) ?? []
    trail.rows = findRows({
      pool: [...pool, ...prepared.rest],
      screen,
      finalists,
      places,
      winner,
      keep: trail.keep!,
      ...(prepared.checks ? { checks: prepared.checks } : {}),
      ...(trail.notScored ? { notScored: trail.notScored } : {})
    })
    trail.stage = 'done'
  }
  if (!finalists.length && (scope.config.findRules ?? 0) >= 3) {
    return fail('No options could be scored.')
  }
  if (finalists.length < 2) {
    scope.runs[judge.id] = [
      { stepId: judge.id, round: 1, state: 'done', calls: screenViews, notes: [] }
    ]
    // The check decided only when it left one version on top; a final of one is JEV's screen.
    return decide(finalists[0]!, prepared.checks && pool.length === 1 ? ['check'] : ['screen'])
  }
  trail.stage = 'final'
  const candidates: GraphCandidate[] = finalists.map((option, index) => ({
    label: graphLabel(index),
    seatId: option.seatId,
    name: option.by,
    markdown: findOptionText(option, scope.config.findRules),
    ...(option.agentIndex !== undefined
      ? { source: { stepId: options.id, agentIndex: option.agentIndex } }
      : {})
  }))
  const final = runGraphStep(scope, judge, 1, { candidates })
  final.calls.unshift(...screenViews)
  scope.runs[judge.id] = [final]
  publishGraphStep(scope, judge, final)
  if (pending(final)) {
    return
  }
  const first = (final.standings ?? []).filter(
    (standing) => standing.votes > 0 && standing.place === 1
  )
  if (!first.length) {
    return decide(finalists[0]!, ['screen'])
  }
  const finalistOf = (label: string) =>
    finalists[candidates.findIndex((entry) => entry.label === label)]!
  // A tie in the final goes to the higher screen score, then to the pool's order.
  const tied = first.map((standing) => finalistOf(standing.label))
  // find-screen@2: an unscored finalist has no screen score to lose a tie on.
  const byScore = !keepsUnscored || tied.every((option) => screen?.scores[option.key] !== undefined)
  const winner = [...tied].sort(
    (left, right) =>
      (byScore ? (screen?.scores[right.key] ?? 0) - (screen?.scores[left.key] ?? 0) : 0) ||
      pool.indexOf(left) - pool.indexOf(right)
  )[0]!
  const modelsRanked = final.calls.some((view) => !view.jev && view.ranking)
  const jevRanked = final.calls.some(
    (view) => view.jev && view.ranking && view.id !== `${judge.id}/screen`
  )
  // An unsure JEV that stood aside for the model judges decided nothing.
  const jevDecided = jevRanked && (!final.jevUnsure || !!final.jevCounted || !modelsRanked)
  if (final.jevUnsure) {
    trail.jevUnsure = true
  }
  const places = new Map(
    (final.standings ?? [])
      .filter((standing) => standing.votes > 0)
      .map((standing) => [finalistOf(standing.label).key, standing.place])
  )
  decide(
    winner,
    [...(jevDecided ? (['jev'] as const) : []), ...(modelsRanked ? (['models'] as const) : [])],
    places
  )
}
