import { graphRoundYield } from './graph-round-yield'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { graphMergeLaterReports, type GraphItem } from './graph-items'
import {
  graphDoneCallIds,
  graphPlural,
  graphUnfinishedSearch,
  type GraphLoopState,
  type GraphStepRun
} from './graph-plan-types'
import { runImproveLoop } from './graph-improve-loop'
import { graphUsesLegacyVerification, publishGraphStep, type GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'
import { graphLoopTarget, graphResurfaced } from './graph-triage'
import { graphWithMergedRepeats } from './graph-impact-answer'
import { graphWebTarget } from './graph-web-citations'

const pending = (run: GraphStepRun | undefined) =>
  !!run && (run.state === 'waiting' || run.state === 'active')

/**
 * The repeat. Called once every outside input of its two steps has settled; it publishes both
 * only when the loop has ended.
 *
 * Until approved: round after round, the Do step revises one piece of work and its Review
 * judges it, until a majority of the reviewers pass it or the rounds run out. The latest round
 * is the loop's output. A revision that fails fails the loop: an earlier, rejected draft never
 * stands in for it.
 *
 * Until nothing new: each round's Do lists what earlier rounds missed and its Review checks
 * each new item. Reviews never gate the next round, so round k+1's Do runs while round k is
 * still being reviewed, and a review that fails leaves its items unverified, never dropped.
 */
export function runGraphLoop(scope: GraphScope): void {
  const repeat = scope.config.spec.repeat!
  const doStep = scope.byId.get(repeat.do)!
  const review = scope.byId.get(repeat.review)!
  scope.runs[doStep.id] = []
  scope.runs[review.id] = []
  if (repeat.until === 'plateau') {
    runImproveLoop(scope, doStep, review)
  } else if (repeat.until === 'approved') {
    runApprovedLoop(scope, doStep, review)
  } else {
    runNothingNewLoop(scope, doStep, review)
  }
}

function reviewRound(
  scope: GraphScope,
  doStep: WorkflowStep,
  review: WorkflowStep,
  round: number,
  doRun: GraphStepRun,
  forItems?: GraphItem[],
  mergeCandidates?: GraphItem[],
  priorityKeys?: Set<string>
): GraphStepRun {
  return runGraphStep(scope, review, round, {
    inLoop: true,
    overrides: new Map([
      [doStep.id, { status: 'ok' as const, run: doRun, callIds: graphDoneCallIds(doRun) }]
    ]),
    ...(forItems ? { forItems } : {}),
    ...(mergeCandidates ? { mergeCandidates } : {}),
    ...(priorityKeys ? { priorityKeys } : {})
  })
}

function runApprovedLoop(scope: GraphScope, doStep: WorkflowStep, review: WorkflowStep): void {
  const repeat = scope.config.spec.repeat!
  const doRuns = scope.runs[doStep.id]
  const reviewRuns = scope.runs[review.id]
  let status: GraphLoopState['status'] = 'running'
  let round = 1
  for (; round <= repeat.maxRounds; round++) {
    const previousDo = doRuns.at(-1)
    const previousReview = reviewRuns.at(-1)
    const doRun = runGraphStep(scope, doStep, round, {
      inLoop: true,
      ...(round > 1
        ? {
            revise: {
              previous: previousDo?.texts?.[0]?.markdown ?? '',
              reviews: (previousReview?.texts ?? []).map((text, index) => ({
                ...text,
                label: `Reviewer ${index + 1}`,
                verdict: previousReview?.verdicts?.[text.agentIndex] ?? null
              }))
            }
          }
        : {})
    })
    doRuns.push(doRun)
    if (pending(doRun)) {
      break
    }
    // A draft that failed, did not run or came back with nothing to review ends the loop.
    if (doRun.state === 'failed' || doRun.state === 'not-run' || doRun.state === 'empty') {
      status = 'failed'
      break
    }
    const reviewRun = reviewRound(scope, doStep, review, round, doRun)
    reviewRuns.push(reviewRun)
    if (pending(reviewRun)) {
      break
    }
    if (
      reviewRun.state === 'failed' ||
      reviewRun.state === 'not-run' ||
      reviewRun.state === 'empty'
    ) {
      // Nobody judged this round, so there is nothing to revise against: stop, do not guess.
      status = 'failed'
      break
    }
    if (reviewRun.approved) {
      status = 'approved'
      break
    }
    if (round === repeat.maxRounds) {
      status = 'not-approved'
      break
    }
  }
  scope.loop = { round: Math.min(round, repeat.maxRounds), maxRounds: repeat.maxRounds, status }
  if (status === 'running') {
    return
  }
  const lastDo = doRuns.at(-1)!
  if (lastDo.state === 'failed' || lastDo.state === 'not-run' || lastDo.state === 'empty') {
    publishGraphStep(scope, doStep, lastDo)
    scope.outputs.set(review.id, {
      status: 'not-run',
      reason: `Not run: ${doStep.title} ${lastDo.state === 'failed' ? 'failed' : lastDo.state === 'empty' ? 'had nothing to work on' : 'did not run'}${lastDo.round > 1 ? ` in round ${lastDo.round}` : ''}.`
    })
    return
  }
  publishGraphStep(scope, doStep, lastDo)
  // The latest round's review, as it came back: a failed one is advisory like any review.
  publishGraphStep(scope, review, reviewRuns.at(-1)!)
}

function runNothingNewLoop(scope: GraphScope, doStep: WorkflowStep, review: WorkflowStep): void {
  const repeat = scope.config.spec.repeat!
  const doRuns = scope.runs[doStep.id]
  const reviewRuns = scope.runs[review.id]
  let known: GraphItem[] = []
  let status: GraphLoopState['status'] = 'running'
  let round = 1
  for (; round <= repeat.maxRounds; round++) {
    const yieldDecision = graphRoundYield(repeat, round, doRuns, reviewRuns)
    if (yieldDecision?.kind === 'wait') {
      break
    }
    if (yieldDecision?.kind === 'skip') {
      scope.notes.push(yieldDecision.reason)
      status = 'low-yield'
      round = 1
      break
    }
    const doRun = runGraphStep(scope, doStep, round, { inLoop: true, known })
    doRuns.push(doRun)
    if (pending(doRun)) {
      break
    }
    if (doRun.state === 'failed' || doRun.state === 'not-run') {
      status = 'failed'
      break
    }
    // What the next round is told is already known: every item so far, with every later
    // wording of it, so a finder never re-reports a claim it was not shown.
    known = mergedLoopItems(doRuns)
    if (
      scope.config.spec.template === 'discover' &&
      !graphUsesLegacyVerification(scope) &&
      reviewRuns.some(pending)
    ) {
      break
    }
    const prior = new Map(
      (scope.config.spec.template === 'discover' && !graphUsesLegacyVerification(scope)
        ? reviewRuns
        : []
      )
        .flatMap((run) => run.targets ?? [])
        .map((target) => [target.item.key, target])
    )
    const backlog = [...prior.values()]
      .filter(
        (target) =>
          target.unchecked &&
          !target.screened &&
          !target.refutedBy &&
          !target.item.evidence?.preVerify?.dropped
      )
      .map((target) => target.item)
    const candidates = [...prior.values()]
      .filter((target) => !backlog.some((item) => item.key === target.item.key))
      .map((target) => target.item)
    const items = [...backlog, ...(doRun.items ?? [])]
    if (!items.length) {
      // Only a round in which every call came back and found nothing new ends the search.
      const clean = doRun.state === 'done'
      reviewRuns.push({
        stepId: review.id,
        round,
        state: 'empty',
        reason: `Nothing new to review: ${doStep.title} found nothing new in round ${round}${clean ? '' : `, but ${doRun.reason}`}.`,
        calls: [],
        notes: []
      })
      if (clean) {
        status = 'dry'
        break
      }
      if (round === repeat.maxRounds) {
        status = 'max-rounds'
        break
      }
      continue
    }
    reviewRuns.push(
      reviewRound(
        scope,
        doStep,
        review,
        round,
        doRun,
        items,
        candidates,
        new Set(backlog.map((item) => item.key))
      )
    )
    if (round === repeat.maxRounds) {
      status = 'max-rounds'
      break
    }
  }
  const lastRound = Math.min(round, repeat.maxRounds)
  if (status === 'running' || reviewRuns.some(pending)) {
    scope.loop = { round: lastRound, maxRounds: repeat.maxRounds, status: 'running' }
    return
  }
  scope.loop = { round: lastRound, maxRounds: repeat.maxRounds, status }
  const goodDo = doRuns.filter((run) => run.state === 'done' || run.state === 'gaps')
  if (!goodDo.length) {
    publishGraphStep(scope, doStep, doRuns[0])
    scope.outputs.set(review.id, { status: 'not-run', reason: `Not run: ${doStep.title} failed.` })
    return
  }
  if (status === 'failed') {
    scope.notes.push(
      `${doStep.title} stopped in round ${lastRound}: ${doRuns.at(-1)?.reason ?? 'it failed.'} What earlier rounds found is kept, so the search may be incomplete.`
    )
  }
  if (status === 'max-rounds') {
    scope.notes.push(graphUnfinishedSearch(doStep.title, repeat.maxRounds))
  }
  // The steps that read the loop see every round's items, and every item's votes: a round whose
  // review failed keeps its items, each unverified. Later rounds' reports of an item are merged
  // into copies, so each round's own record and the prompts built from it stay as they were.
  const items = mergedLoopItems(goodDo)
  const byKey = new Map(items.map((item) => [item.key, item]))
  scope.outputs.set(doStep.id, {
    status: 'ok',
    run: { ...goodDo.at(-1)!, items, calls: goodDo.flatMap((run) => run.calls) },
    callIds: goodDo.flatMap(graphDoneCallIds)
  })
  // The rounds that had something to review decide the loop review's state; a round that found
  // nothing new is how the loop ends, not a review.
  const latest = new Map(
    reviewRuns.flatMap((run) => run.targets ?? []).map((target) => [target.item.key, target])
  )
  const absorbed = new Set([...latest.values()].flatMap((target) => target.item.alsoMerged ?? []))
  const targets = [...latest.values()]
    .filter((target) => !absorbed.has(target.item.key))
    .map((target) => {
      const looped = graphLoopTarget(target, byKey.get(target.item.key))
      const item = looped.item.alsoMerged
        ? graphWithMergedRepeats(looped.item, (key) => byKey.get(key))
        : looped.item
      return graphResurfaced({ ...looped, item }, target.item)
    })
    // A later report merged in brings its own quotes: they are checked before anything reads it.
    .map((target) => graphWebTarget(scope, target))
  const resurfaced = targets.filter((target) => target.resurfaced).length
  if (resurfaced) {
    scope.notes.push(
      `${review.title}: ${graphPlural(resurfaced, 'item')} JEV set aside ${resurfaced === 1 ? 'was' : 'were'} reported again in a later round, so the report lists ${resurfaced === 1 ? 'it' : 'them'} as unverified.`
    )
  }
  const real = reviewRuns.filter((run) => run.state !== 'empty')
  const reviewed = real.filter((run) => run.state === 'done' || run.state === 'gaps')
  const aggregate: GraphStepRun = {
    ...(real.at(-1) ?? reviewRuns.at(-1)!),
    state: !real.length
      ? 'empty'
      : reviewed.length === real.length && reviewed.every((run) => run.state === 'done')
        ? 'done'
        : 'gaps',
    targets,
    calls: reviewRuns.flatMap((run) => run.calls)
  }
  const reason =
    real.length > 1 && !reviewed.length
      ? `${review.title} failed in all ${real.length} rounds that had something to review.`
      : (real.at(-1)?.reason ?? `${review.title} failed.`)
  scope.outputs.set(
    review.id,
    real.length && real.every((run) => run.state === 'not-run')
      ? { status: 'not-run', reason, run: aggregate }
      : !real.length || reviewed.length
        ? { status: 'ok', run: aggregate, callIds: reviewRuns.flatMap(graphDoneCallIds) }
        : { status: 'failed', reason, run: aggregate }
  )
}

/** Every round's items so far, as copies with later rounds' reports of each merged in. */
function mergedLoopItems(doRuns: readonly GraphStepRun[]): GraphItem[] {
  const good = doRuns.filter((run) => run.state === 'done' || run.state === 'gaps')
  return graphMergeLaterReports(
    good.flatMap((run) => run.items ?? []),
    good.flatMap((run) => run.knownReports ?? [])
  )
}
