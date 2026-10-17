import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { councilMarkdown } from '../presets/council-ranking'
import { graphFirstReview, graphStandInReviewer } from './graph-first-reviewer'
import type { GraphItem } from './graph-items'
import { parseGraphVerdict } from './graph-parse'
import { graphPlural, type GraphOutcome, type GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { graphCallId } from './graph-step-calls'

/** A review that settled without a verdict: failed (not skipped), empty, or with none to read. */
function gaveNoAnswer(outcome: GraphOutcome): boolean {
  if ('failed' in outcome) {
    return !outcome.skipped
  }
  const text = councilMarkdown(outcome.value)
  return !text || !parseGraphVerdict(text)
}

/**
 * Which items' first review gave no answer and is made once more by a stand-in on another
 * provider (graphStandInReviewer), up to the step's `max` a round: item key to the stand-in's
 * agent index. Decided once every first review is in, in the items' order, as escalations are.
 * Undefined unless the step escalates with `standIn` (older specs replay without one).
 */
export function graphStandIns(
  scope: GraphScope,
  step: WorkflowStep,
  round: number,
  inLoop: boolean,
  instances: readonly (GraphItem | undefined)[],
  run: GraphStepRun,
  where: string
): Map<string, number> | undefined {
  if (!step.escalate?.standIn || step.kind !== 'review' || !step.forEach) {
    return undefined
  }
  const standIns = new Map<string, number>()
  const firsts = instances.map((item) =>
    scope.outcomes.get(
      graphCallId(step, round, inLoop, item, graphFirstReview(scope, step, item).index)
    )
  )
  if (!firsts.every(Boolean)) {
    return standIns
  }
  let wanted = 0
  instances.forEach((item, index) => {
    const standIn =
      item && gaveNoAnswer(firsts[index]!) ? graphStandInReviewer(scope, step, item) : undefined
    if (standIn === undefined) {
      return
    }
    wanted++
    if (standIns.size < step.escalate!.max) {
      standIns.set(item!.key, standIn)
    }
  })
  if (wanted) {
    run.notes.push(
      `${where}: the first review of ${graphPlural(wanted, 'item')} gave no answer, so a reviewer on another provider checked ${standIns.size === wanted ? (wanted === 1 ? 'it' : 'each') : `${standIns.size} of them`} instead${wanted > standIns.size ? `; the other ${wanted - standIns.size} had none, past the limit of ${step.escalate.max} a round` : ''}.`
    )
  }
  return standIns
}
