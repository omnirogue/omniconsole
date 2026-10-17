import type {
  WorkflowImprovePrediction,
  WorkflowPredictionOp
} from '../../../../shared/workflow-improve-trail'
import type { GraphCheckResult } from './graph-plan-types'

type Predicted = NonNullable<WorkflowImprovePrediction['predicted']>

const PREDICTION_LINE =
  /^\s*PREDICTION:\s*(?:(PASS|FAIL)|SCORE\s*(>=|<=|≥|≤|>|<)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?))\s*$/i

const OPS: Record<string, WorkflowPredictionOp> = {
  '>=': '>=',
  '≥': '>=',
  '<=': '<=',
  '≤': '<=',
  '>': '>',
  '<': '<'
}

/**
 * The prediction a version ends with: its last non-empty line, `PREDICTION: PASS`, `FAIL` or
 * `SCORE >= n` (also <=, >, <). A prediction anywhere else does not count, so it is made once.
 */
export function parseGraphPrediction(markdown: string): Predicted | undefined {
  const last = markdown.split(/\r?\n/).findLast((line) => line.trim()) ?? ''
  const match = PREDICTION_LINE.exec(last)
  if (!match) {
    return undefined
  }
  if (match[1]) {
    return { outcome: match[1].toUpperCase() === 'PASS' ? 'pass' : 'fail' }
  }
  const score = Number(match[3])
  return Number.isFinite(score) ? { op: OPS[match[2]!]!, score } : undefined
}

function scoreHolds(op: WorkflowPredictionOp, measured: number, predicted: number): boolean {
  switch (op) {
    case '>=':
      return measured >= predicted
    case '<=':
      return measured <= predicted
    case '>':
      return measured > predicted
    case '<':
      return measured < predicted
  }
}

/**
 * Whether a version's prediction held against its check. The version's text was fixed before
 * its check ran, so the prediction was registered in advance by construction. A check that could
 * not run tests nothing, so the prediction is neither held nor missed.
 */
export function judgeGraphPrediction(
  markdown: string,
  check: GraphCheckResult | undefined
): WorkflowImprovePrediction {
  const predicted = parseGraphPrediction(markdown)
  if (!predicted) {
    return { verdict: 'missing' }
  }
  if (!check || check.unavailable) {
    return { verdict: 'untested', predicted }
  }
  const measured = {
    passed: check.passed,
    ...(check.score !== undefined ? { score: check.score } : {})
  }
  const held =
    'outcome' in predicted
      ? (predicted.outcome === 'pass') === check.passed
      : check.score !== undefined && scoreHolds(predicted.op, check.score, predicted.score)
  return { verdict: held ? 'held' : 'missed', predicted, measured }
}

/** Kept versions go on to be compared; a missed or missing prediction kills the version. */
export function graphPredictionKept(prediction: WorkflowImprovePrediction | undefined): boolean {
  return !prediction || prediction.verdict === 'held' || prediction.verdict === 'untested'
}
