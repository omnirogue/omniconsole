import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import type {
  WorkflowImproveFinal,
  WorkflowImproveFinalSide
} from '../../../../shared/workflow-improve-trail'
import type { ImproveVersion } from './graph-improve-decide'
import { checkResult, compareImproveMeasure, improveCheckRequest } from './graph-improve-check'
import {
  GRAPH_CHECK_SEAT_ID,
  graphPlural,
  type GraphCheckRequest,
  type GraphCheckResult,
  type GraphConfig
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'

type FinalSide = 'best' | 'start'

/** `<do step>/final/<best|start>/check`: the final test's two calls, apart from every round's. */
export function graphFinalCheckCallId(doStepId: string, side: FinalSide): string {
  return `${doStepId}/final/${side}/check`
}

/** The version's own test settings, with the kept-back command and cases in place of practice. */
function finalRequest(
  config: Pick<GraphConfig, 'spec' | 'improveRules'>,
  version: ImproveVersion
): GraphCheckRequest {
  const sealed = config.spec.repeat!.check!.sealed!
  const { command, cases: _practice, ...rules } = improveCheckRequest(config)
  return {
    ...rules,
    command: sealed.command ?? command,
    candidate: version.text.markdown,
    ...(sealed.cases?.length ? { cases: sealed.cases } : {}),
    ...(version.round === 0 ? { unchanged: true as const } : {}),
    sealed: true
  }
}

/** One side's count: cases passed, or 1 for a pass without cases; unknown if any part could not run. */
function sideOf(result: GraphCheckResult): WorkflowImproveFinalSide & { unknown: boolean } {
  return {
    passed: result.cases ? result.cases.passed : result.passed ? 1 : 0,
    ...(result.score !== undefined ? { score: result.score } : {}),
    unknown: !!result.unavailable || (result.cases?.unavailable ?? 0) > 0
  }
}

/** After the last round, so nothing it finds reaches a prompt: the winner against where it started. */
export function planImproveFinal(
  scope: GraphScope,
  doStepId: string,
  round: number,
  versions: { best: ImproveVersion; start: ImproveVersion }
): WorkflowImproveFinal {
  const sealed = scope.config.spec.repeat!.check!.sealed!
  const final: WorkflowImproveFinal = {
    cases: sealed.cases?.length ?? 0,
    start: versions.start.round === 0 ? 'unchanged' : 'round-1'
  }
  if (versions.best.text.callId === versions.start.text.callId) {
    return { ...final, verdict: 'same' }
  }
  const results = (['best', 'start'] as const).map((side) => {
    const version = versions[side]
    const id = graphFinalCheckCallId(doStepId, side)
    scope.calls.push({
      id,
      prompt: '',
      schema: textAnswerSchema,
      output: 'text',
      seatId: GRAPH_CHECK_SEAT_ID,
      dependencies: [version.text.callId],
      stepId: doStepId,
      round,
      agentIndex: version.text.agentIndex,
      check: finalRequest(scope.config, version),
      validateSemantics: () => null
    })
    const outcome = scope.outcomes.get(id)
    return outcome ? sideOf(checkResult(outcome)) : undefined
  })
  const [best, started] = results
  if (!best || !started) {
    return final
  }
  const sides = {
    best: { passed: best.passed, ...(best.score !== undefined ? { score: best.score } : {}) },
    started: {
      passed: started.passed,
      ...(started.score !== undefined ? { score: started.score } : {})
    }
  }
  if (best.unknown || started.unknown) {
    return { ...final, ...sides, verdict: 'unavailable' }
  }
  const measure = (side: WorkflowImproveFinalSide) => [
    side.passed,
    side.score ?? Number.NEGATIVE_INFINITY
  ]
  const order = compareImproveMeasure(measure(best), measure(started))
  return { ...final, ...sides, verdict: order > 0 ? 'held' : order === 0 ? 'tied' : 'worse' }
}

const scoreText = (score: number | undefined) =>
  score === undefined ? 'no score' : String(Number(score.toFixed(2)))

/** The story's first line: what the final test found, in the person's words; none without one. */
export function graphImproveFinalLine(final: WorkflowImproveFinal | undefined): string | undefined {
  if (!final?.verdict) {
    return undefined
  }
  const kept = final.cases ? `${graphPlural(final.cases, 'case')} kept back` : 'a command kept back'
  const head = `Final test (${kept})`
  const code = final.start === 'unchanged'
  if (final.verdict === 'same') {
    return `${head}: not needed, since the result ${code ? 'is your code as it is' : "is still round 1's best version"}.`
  }
  if (final.verdict === 'unavailable' || !final.best || !final.started) {
    return `${head}: it could not run in full, so whether the improvement holds is unknown.`
  }
  const { best, started } = final
  const passed = (side: WorkflowImproveFinalSide) =>
    final.cases ? `passed ${side.passed}` : side.passed ? 'passed' : 'failed'
  const scored =
    best.score !== started.score
      ? `, and the new version scored ${scoreText(best.score)} against ${scoreText(started.score)}`
      : ''
  const results =
    best.passed === started.passed
      ? `both ${passed(best)}${scored}`
      : `the new version ${passed(best)}, ${code ? 'what you started with' : "round 1's best version"} ${passed(started)}`
  switch (final.verdict) {
    case 'held':
      return `${head}: ${results}. The improvement held.`
    case 'tied':
      return `${head}: ${results}. It did no better on cases it never saw, so the gain may not carry over.`
    case 'worse':
      return `${head}: ${results}. ${code ? 'Keep what you have.' : "Round 1's best version may be the better choice."}`
  }
}
