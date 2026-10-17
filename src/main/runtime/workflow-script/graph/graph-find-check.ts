import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowCheck, WorkflowStep } from '../../../../shared/workflow-graph'
import type { FindOption } from './graph-find-pool'
import { checkResult, graphCheckCallId } from './graph-improve-check'
import {
  GRAPH_CHECK_SEAT_ID,
  type GraphCall,
  type GraphCallView,
  type GraphCheckResult,
  type GraphOutcome
} from './graph-plan-types'

const rank = (check: GraphCheckResult | undefined): [number, number] => [
  check?.passed ? 1 : 0,
  check?.score ?? Number.NEGATIVE_INFINITY
]

/** Passing first, then the higher score; no score ranks below any score. */
const compare = (left: [number, number], right: [number, number]) =>
  right[0] - left[0] || (right[1] === left[1] ? 0 : right[1] > left[1] ? 1 : -1)

/**
 * Complete versions under the person's check, as Improve checks its versions: every version runs
 * the check, passing beats failing and a higher score beats a lower one, whatever a judge thinks.
 * The versions the check cannot tell apart go on to the judges; the rest follow, in check order.
 * 'pending' while a check still runs.
 */
export function withVersionChecks(input: {
  check: WorkflowCheck
  judge: WorkflowStep
  pool: FindOption[]
  outcomes: ReadonlyMap<string, GraphOutcome>
  trail: WorkflowFindTrail
  calls: GraphCall[]
  views: GraphCallView[]
}):
  | { contenders: FindOption[]; rest: FindOption[]; checks: Map<string, GraphCheckResult> }
  | 'pending' {
  const checks = new Map<string, GraphCheckResult>()
  for (const option of input.pool) {
    const author = option.callId!
    const id = graphCheckCallId(author)
    const call: GraphCall = {
      id,
      prompt: '',
      schema: textAnswerSchema,
      output: 'text',
      seatId: GRAPH_CHECK_SEAT_ID,
      dependencies: [author],
      stepId: input.judge.id,
      round: 1,
      agentIndex: option.agentIndex ?? 0,
      check: { command: input.check.command, candidate: option.text ?? option.detail },
      validateSemantics: () => null
    }
    input.calls.push(call)
    const outcome = input.outcomes.get(id)
    input.views.push({
      id,
      stepId: input.judge.id,
      round: 1,
      agentIndex: call.agentIndex,
      seatId: GRAPH_CHECK_SEAT_ID,
      status: outcome ? 'done' : 'ready'
    })
    if (outcome) {
      checks.set(option.key, checkResult(outcome))
    }
  }
  input.trail.check = {
    command: input.check.command,
    checked: checks.size,
    passed: [...checks.values()].filter((result) => result.passed).length,
    unavailable: [...checks.values()].filter((result) => result.unavailable).length
  }
  if (checks.size < input.pool.length) {
    input.trail.stage = 'check'
    return 'pending'
  }
  const byCheck = (left: FindOption, right: FindOption) =>
    compare(rank(checks.get(left.key)), rank(checks.get(right.key)))
  const best = input.pool.toSorted(byCheck)[0]!
  const inTop = (option: FindOption) => byCheck(option, best) === 0
  return {
    contenders: input.pool.filter(inTop),
    rest: input.pool.filter((option) => !inTop(option)).toSorted(byCheck),
    checks
  }
}
