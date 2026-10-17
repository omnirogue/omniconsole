import type { WorkflowRepeat } from '../../../../shared/workflow-graph'
import type { GraphStepRun } from './graph-plan-types'

type YieldDecision = { kind: 'wait' } | { kind: 'skip'; reason: string }

/** A low-yield stop needs a settled, complete first round; overflow keeps another round. */
export function graphRoundYield(
  repeat: WorkflowRepeat,
  round: number,
  doRuns: readonly GraphStepRun[],
  reviewRuns: readonly GraphStepRun[]
): YieldDecision | undefined {
  if (round !== 2 || !repeat.minConfirmedForRound2) {
    return undefined
  }
  const first = reviewRuns[0]
  if (first?.state === 'waiting' || first?.state === 'active') {
    return { kind: 'wait' }
  }
  if (
    doRuns[0]?.state !== 'done' ||
    first?.state !== 'done' ||
    (first.targets ?? []).some((target) => target.unchecked && !target.screened)
  ) {
    return undefined
  }
  const confirmed = new Set(
    (first.targets ?? [])
      .filter((target) => target.tally === 'confirmed')
      .map((target) => target.item.key)
  ).size
  return confirmed < repeat.minConfirmedForRound2
    ? {
        kind: 'skip',
        reason: `Skipped round 2: round 1 confirmed ${confirmed}, below minConfirmedForRound2=${repeat.minConfirmedForRound2}.`
      }
    : undefined
}
