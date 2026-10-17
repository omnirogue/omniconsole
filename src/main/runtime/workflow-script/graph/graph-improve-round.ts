import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  arrangeImproveLineup,
  decideImproveRound,
  nextImproveAlternative,
  type ImproveVersion
} from './graph-improve-decide'
import { checkContenders, improveCheckRequest, planImproveChecks } from './graph-improve-check'
import type { ImproveParent } from './graph-improve-archive'
import { graphImproveJudgeTask } from './graph-improve-prompts'
import { graphImproveWeakest, type GraphImproveReflection } from './graph-improve-reflection'
import {
  graphImproveChangesCode,
  graphImprovePredicts,
  graphImproveVerifiesAcrossFamilies
} from './graph-improve-rules'
import { graphPredictionKept, judgeGraphPrediction } from './graph-check-prediction'
import { graphJudgeAgreement } from './graph-judge-agreement'
import { graphLabel } from './graph-parse'
import {
  graphDoneCallIds,
  type GraphCandidate,
  type GraphImproveBrief,
  type GraphImproveRound,
  type GraphStepRun
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'

/** What carries from one round to the next. */
export type ImproveCarry = {
  best?: ImproveVersion
  alternative?: ImproveVersion
  feedback?: GraphImproveBrief['feedback']
  /** Several versions to build on (rules 2): the best first, then the others kept. */
  archive?: ImproveParent[]
  /** Rules 3: what the next improvers fix first and must not repeat. */
  reflection?: GraphImproveReflection
}

export type ImproveRoundInput = {
  doStep: WorkflowStep
  judge: WorkflowStep
  doRun: GraphStepRun
  round: number
  challengers: ImproveVersion[]
  entry: GraphImproveRound
  carry: ImproveCarry
  /** Rules 3: every change to the code checked so far this run, by normalizedPatchKey. */
  checkedChanges?: Map<string, ImproveVersion>
}

const pending = (run: GraphStepRun | undefined) =>
  !!run && (run.state === 'waiting' || run.state === 'active')

function notJudged(judge: WorkflowStep, round: number, reason: string): GraphStepRun {
  return { stepId: judge.id, round, state: 'empty', reason, calls: [], notes: [] }
}

function candidateView(version: ImproveVersion, label: string) {
  return {
    label,
    name: version.text.name,
    seatId: version.text.seatId,
    role: version.role,
    // The best going into a round shows no parent: that belongs to the round that made it.
    ...(version.parent && version.role !== 'best' ? { parent: version.parent } : {}),
    ...(version.prediction && version.role !== 'best' ? { prediction: version.prediction } : {}),
    ...(version.duplicateOf && version.role !== 'best'
      ? { duplicateOf: { ...version.duplicateOf } }
      : {}),
    ...(version.check
      ? {
          check: {
            passed: version.check.passed,
            ...(version.check.score !== undefined ? { score: version.check.score } : {}),
            ...(version.check.unavailable ? { unavailable: true as const } : {}),
            ...(version.check.cases
              ? { cases: { passed: version.check.cases.passed, total: version.check.cases.total } }
              : {}),
            ...(version.check.exits ? { exits: version.check.exits } : {})
          }
        }
      : {})
  }
}

/**
 * One round after its improvers settled. With a check, every new version is checked first and
 * the check decides whatever it can: passing beats failing, a higher score beats a lower one.
 * The judges decide only among the versions the check cannot tell apart, and a tie keeps the
 * best version. Returns undefined while a check or a judge is still at work.
 */
export function settleImproveRound(
  scope: GraphScope,
  input: ImproveRoundInput
): { improved: boolean; carry: ImproveCarry } | undefined {
  const { doStep, judge, challengers, entry, carry } = input
  const check = scope.config.spec.repeat?.check
  if (
    check &&
    planImproveChecks(
      scope,
      doStep.id,
      challengers,
      improveCheckRequest(scope.config),
      input.checkedChanges
    )
  ) {
    return undefined
  }
  if (!graphImprovePredicts(scope.config)) {
    return settleCheckedRound(scope, input)
  }
  for (const version of challengers) {
    version.prediction = judgeGraphPrediction(version.text.markdown, version.check)
  }
  // Killed versions leave before the check compares anything: they are never contenders.
  const kept = challengers.filter((version) => graphPredictionKept(version.prediction))
  const killed = challengers.filter((version) => !kept.includes(version))
  const killedViews = (from: number) =>
    killed.map((version, index) => candidateView(version, graphLabel(from + index)))
  if (!kept.length && !carry.best) {
    entry.result = 'failed'
    entry.reason = "Every new version's prediction missed its test result, so none was kept."
    entry.judgedBy = ['check']
    entry.candidates = killedViews(0)
    scope.runs[judge.id].push(notJudged(judge, input.round, 'Every new version was killed.'))
    return { improved: false, carry }
  }
  const settled = settleCheckedRound(scope, { ...input, challengers: kept })
  if (settled) {
    entry.candidates.push(...killedViews(entry.candidates.length))
  }
  return settled
}

/**
 * The lineup with each change in it once (rules 3, diff noise aside): the best version's own, else
 * the first version that made it. Versions without a key all stay.
 */
function firstOfEachChange(
  best: ImproveVersion | undefined,
  lineup: readonly ImproveVersion[]
): ImproveVersion[] {
  const seen = new Set(best?.patchKey ? [best.patchKey] : [])
  return lineup.filter((version) => {
    if (version === best || !version.patchKey) {
      return true
    }
    if (seen.has(version.patchKey)) {
      return false
    }
    seen.add(version.patchKey)
    return true
  })
}

/** The round once every version is checked (and, with predictions, only the ones kept). */
function settleCheckedRound(
  scope: GraphScope,
  input: ImproveRoundInput
): { improved: boolean; carry: ImproveCarry } | undefined {
  const { doStep, judge, doRun, round, challengers, entry, carry } = input
  const judgeRuns = scope.runs[judge.id]
  const check = scope.config.spec.repeat?.check
  const best = carry.best
  if (!best && challengers.length === 1) {
    entry.result = 'first'
    entry.judgedBy = check ? ['check'] : []
    entry.candidates = [{ ...candidateView(challengers[0], graphLabel(0)), accepted: true }]
    judgeRuns.push(notJudged(judge, round, 'One first version: nothing to compare yet.'))
    return { improved: false, carry: { ...carry, best: { ...challengers[0], role: 'best' } } }
  }
  const lineup = arrangeImproveLineup(best, challengers, round)
  const judged = firstOfEachChange(best, lineup)
  // Every new version repeats the best version's change: it stays as identical, unjudged.
  const repeatsBest = !!best && judged.length === 1 && lineup.length > 1
  const contenders = check ? checkContenders(judged) : judged
  if (check && contenders.length === 1 && !repeatsBest) {
    // The check alone decided: no judge is asked.
    const winner = contenders[0]
    const improved = !!best && winner !== best
    entry.result = !best ? 'first' : improved ? 'new-best' : 'kept'
    entry.judgedBy = ['check']
    entry.candidates = lineup.map((version, index) => ({
      ...candidateView(version, graphLabel(index)),
      ...(version === winner && (improved || !best) ? { accepted: true as const } : {})
    }))
    judgeRuns.push(notJudged(judge, round, 'Decided by the check: no judge was needed.'))
    return {
      improved,
      carry: { ...carry, best: { ...winner, role: 'best' }, feedback: undefined }
    }
  }
  if (
    best &&
    contenders.includes(best) &&
    contenders.every((version) => version.text.markdown.trim() === best.text.markdown.trim())
  ) {
    entry.result = 'kept'
    entry.judgedBy = check ? ['check'] : []
    entry.candidates = lineup.map((version, index) => candidateView(version, graphLabel(index)))
    judgeRuns.push(notJudged(judge, round, 'Identical to the best version: no judge was needed.'))
    return {
      improved: false,
      carry: { ...carry, feedback: undefined }
    }
  }
  const candidates: GraphCandidate[] = contenders.map((version, index) => ({
    label: graphLabel(index),
    seatId: version.text.seatId,
    name: version.text.name,
    markdown: version.text.markdown,
    // "No change" (round 0) was written by no agent, so no seat's prompt is credited with it.
    ...(version.round > 0
      ? { source: { stepId: doStep.id, agentIndex: version.text.agentIndex } }
      : {}),
    ...(version === best ? { incumbent: true as const } : {})
  }))
  const defending = candidates.find((candidate) => candidate.incumbent)
  const judgeTask = graphImproveJudgeTask(
    scope.task.prompt,
    doStep.instruction,
    graphImproveChangesCode(scope.config)
  )
  const judgeRun = runGraphStep(scope, judge, round, {
    inLoop: true,
    candidates,
    ...(judgeTask !== scope.task.prompt ? { judgeTask } : {}),
    // With two answers JEV's top-two rule already is this test (and the request stays as it was).
    ...(defending && candidates.length > 2 ? { incumbent: defending.label } : {}),
    overrides: new Map([
      [doStep.id, { status: 'ok' as const, run: doRun, callIds: graphDoneCallIds(doRun) }]
    ])
  })
  judgeRuns.push(judgeRun)
  if (pending(judgeRun)) {
    return undefined
  }
  const lineageOf = graphImproveVerifiesAcrossFamilies(scope.config)
    ? (seatId: string) =>
        scope.config.seats.find((seat) => seat.id === seatId)?.lineage ?? 'unknown'
    : undefined
  const decision = decideImproveRound(contenders, candidates, judgeRun, best, lineageOf)
  const winner = contenders[decision.index]
  // The best version is out of the running only when the check put a challenger above it.
  const improved = !!best && winner !== best
  entry.result = !best ? 'first' : decision.unjudged ? 'unjudged' : improved ? 'new-best' : 'kept'
  if (decision.reason) {
    entry.reason = decision.reason
  }
  if (judgeRun.jevUnsure) {
    entry.jevUnsure = true
  }
  if (judgeRun.jevCounted) {
    entry.jevCounted = true
  }
  const agreement = graphJudgeAgreement(judgeRun, candidates)
  if (agreement) {
    entry.agreed = agreement.topSame
  }
  entry.judgedBy = [
    ...(check ? (['check'] as const) : []),
    ...(judgeRun.calls.some((view) => view.jev && view.ranking) ? (['jev'] as const) : []),
    ...(judgeRun.calls.some((view) => !view.jev && view.ranking) ? (['models'] as const) : [])
  ]
  entry.candidates = lineup.map((version, index) => {
    const at = contenders.indexOf(version)
    const standing =
      at === -1 ? undefined : judgeRun.standings?.find((row) => row.label === candidates[at].label)
    return {
      ...candidateView(version, graphLabel(index)),
      ...(standing?.votes ? { place: standing.place, votes: standing.votes } : {}),
      ...(version === winner && (improved || !best) ? { accepted: true as const } : {})
    }
  })
  const nextBest: ImproveVersion = { ...winner, role: 'best' }
  const weakest = graphImproveWeakest(scope, judgeRun, candidates[decision.index].label)
  let alternative =
    nextImproveAlternative(contenders, candidates, judgeRun, decision.index) ?? carry.alternative
  if (alternative && alternative.text.callId === nextBest.text.callId) {
    alternative = undefined
  }
  return {
    improved,
    carry: {
      best: nextBest,
      ...(alternative ? { alternative } : {}),
      feedback: {
        bestLabel: candidates[decision.index].label,
        ballots: (judgeRun.texts ?? []).map((text, index) => ({
          label: `Judge ${index + 1}`,
          name: text.name,
          markdown: text.markdown
        })),
        ...(weakest.length ? { weakest } : {})
      }
    }
  }
}
