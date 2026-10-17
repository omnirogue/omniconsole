import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { graphImproveBestOutput } from './graph-improve-baseline'
import type { ImproveVersion } from './graph-improve-decide'
import { graphDoneCallIds, type GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

export function graphImproveNotJudged(
  judge: WorkflowStep,
  round: number,
  reason: string
): GraphStepRun {
  return { stepId: judge.id, round, state: 'not-run', reason, calls: [], notes: [] }
}

/** The loop's result: the best version for the steps that read Improve, the last ranking for Judge. */
export function publishImprove(
  scope: GraphScope,
  doStep: WorkflowStep,
  judge: WorkflowStep,
  best: ImproveVersion | undefined
): void {
  const doRuns = scope.runs[doStep.id]
  const judgeRuns = scope.runs[judge.id]
  if (!best) {
    const last = doRuns.at(-1)!
    scope.outputs.set(doStep.id, {
      status: last.state === 'not-run' ? 'not-run' : 'failed',
      reason: last.reason ?? `${doStep.title} returned no version.`,
      run: last
    })
    scope.outputs.set(judge.id, {
      status: 'not-run',
      reason: `Not run: ${doStep.title} returned no version to improve on.`
    })
    return
  }
  scope.outputs.set(doStep.id, { status: 'ok', ...graphImproveBestOutput(doRuns, doStep, best) })
  const judged = judgeRuns.findLast((run) => run.state === 'done' || run.state === 'gaps')
  scope.outputs.set(
    judge.id,
    judged
      ? { status: 'ok', run: judged, callIds: graphDoneCallIds(judged) }
      : {
          status: 'ok',
          run: { ...graphImproveNotJudged(judge, 1, 'Nothing needed comparing.'), state: 'empty' },
          callIds: []
        }
  )
}
