import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { ImproveVersion } from './graph-improve-decide'
import { improveCheckRequest, planImproveChecks } from './graph-improve-check'
import type { GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** Round 0: "No change" is never an agent's answer, so it has no agent call and no seat. */
const GRAPH_UNCHANGED_SEAT_ID = 'unchanged'
const GRAPH_UNCHANGED_NAME = 'No change'
const UNCHANGED_MARKDOWN = 'No change: your code as it is now, with nothing applied.'

/** Where "No change" is recorded, beside the Do step's own calls (its check adds `/check`). */
export function graphUnchangedCallId(doStepId: string): string {
  return `${doStepId}/r0/unchanged`
}

/**
 * "No change": the code as it is. When each version is a change to the code, it is checked
 * before round one and holds the lead from the start, so a change wins only by beating the code
 * it changes. Undefined while its check runs.
 */
export function planImproveUnchanged(
  scope: GraphScope,
  doStep: WorkflowStep
): ImproveVersion | undefined {
  const version: ImproveVersion = {
    text: {
      label: GRAPH_UNCHANGED_NAME,
      name: GRAPH_UNCHANGED_NAME,
      markdown: UNCHANGED_MARKDOWN,
      agentIndex: -1,
      seatId: GRAPH_UNCHANGED_SEAT_ID,
      callId: graphUnchangedCallId(doStep.id)
    },
    round: 0,
    role: 'best'
  }
  const request = { ...improveCheckRequest(scope.config), unchanged: true as const }
  return planImproveChecks(scope, doStep.id, [version], request) ? undefined : version
}

/**
 * What Improve publishes for its best version: the round that made it, or for "No change" a
 * round of its own. Its call ids are what later steps depend on, and "No change" has none.
 */
export function graphImproveBestOutput(
  doRuns: readonly GraphStepRun[],
  doStep: WorkflowStep,
  best: ImproveVersion
): { run: GraphStepRun; callIds: string[] } {
  if (best.round === 0) {
    return {
      run: { stepId: doStep.id, round: 0, state: 'done', calls: [], notes: [], texts: [best.text] },
      callIds: []
    }
  }
  const source = doRuns.find((run) => run.round === best.round)!
  return { run: { ...source, state: 'done', texts: [best.text] }, callIds: [best.text.callId] }
}
