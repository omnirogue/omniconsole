import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { WORKFLOW_COMPARE_FIRST_ROUND } from '../../../../shared/workflow-graph-decide-fields'
import { graphStandings, type GraphStanding } from './graph-parse'
import type { GraphCandidate, GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'

/** One rubric line of a comparison: settled by JEV or by judges in both orders, or not at all. */
export type GraphCompareLine = {
  runs: GraphStepRun[]
  state: 'pending' | 'settled' | 'unsettled' | 'blocked'
  standings?: GraphStanding[]
  judgedBy: ('jev' | 'models')[]
  /** Why the line is not settled; it is then left out of the overall order and is a gap. */
  why?: string
  blocked?: GraphStepRun
}

const pending = (run: GraphStepRun) => run.state === 'waiting' || run.state === 'active'

/** Each model judge's ballot, by seat. */
const ballots = (run: GraphStepRun) =>
  run.calls.flatMap((view) =>
    !view.jev && view.ranking ? [{ seatId: view.seatId, ranking: view.ranking }] : []
  )

/** The answers a seat may place, first first: its own model's answers never count. */
function firstEligible(shown: readonly GraphCandidate[], seatId: string, ranking: string[]) {
  const own = new Set(shown.filter((entry) => entry.seatId === seatId).map((entry) => entry.label))
  const allOwn = own.size === shown.length
  return ranking.find((label) => allOwn || !own.has(label))
}

/**
 * One rubric line in rounds 3+2i (as shown, with JEV pairwise in both orders) and 4+2i (the
 * judges again, each seeing its own first order reversed), the second only when JEV was unsure or failed.
 * Judges settle the line only when each gave a ballot in both orders with the same first
 * place; an unsure JEV ballot never settles it.
 */
export function resolveCompareLine(
  scope: GraphScope,
  step: WorkflowStep,
  shown: GraphCandidate[],
  line: string,
  index: number
): GraphCompareLine {
  const judge = {
    ...step,
    title: `${step.title} (${line})`,
    instruction: `Rank the options below on this one question only, ignoring every other quality: ${line}`
  }
  const round = WORKFLOW_COMPARE_FIRST_ROUND + 2 * index
  const extras = { inLoop: true, candidates: shown, decisionPoint: `${step.id}/line` }
  const forward = runGraphStep(
    scope,
    { ...judge, jev: { method: 'pairwise', only: true } },
    round,
    extras
  )
  if (forward.state === 'not-run' || forward.state === 'empty') {
    return { runs: [forward], state: 'blocked', judgedBy: [], blocked: forward }
  }
  if (pending(forward)) {
    return { runs: [forward], state: 'pending', judgedBy: [] }
  }
  const jevView = forward.calls.find((view) => view.jev)
  if (jevView?.ranking && !forward.jevUnsure) {
    return { runs: [forward], state: 'settled', standings: forward.standings, judgedBy: ['jev'] }
  }
  const { jev: _jev, ...models } = judge
  // Each judge sees exactly the reverse of its own (rotated) first order.
  const reverse = runGraphStep(scope, models, round + 1, { ...extras, reverse: true })
  const runs = [forward, reverse]
  if (pending(reverse)) {
    return { runs, state: 'pending', judgedBy: [] }
  }
  const jev = jevView?.ranking ? 'JEV was not sure' : 'JEV could not judge'
  const first = ballots(forward)
  const second = ballots(reverse)
  const seats = [...new Set([...first, ...second].map((ballot) => ballot.seatId))]
  if (!seats.length) {
    return { runs, state: 'unsettled', judgedBy: [], why: `${jev} and no model judge answered` }
  }
  const split = seats.find((seatId) => {
    const one = first.find((ballot) => ballot.seatId === seatId)
    const two = second.find((ballot) => ballot.seatId === seatId)
    return (
      !one ||
      !two ||
      firstEligible(shown, seatId, one.ranking) !== firstEligible(shown, seatId, two.ranking)
    )
  })
  if (split) {
    return {
      runs,
      state: 'unsettled',
      judgedBy: [],
      why: `${jev}, and a model judge ${[first, second].every((list) => list.some((ballot) => ballot.seatId === split)) ? 'put a different option first when the order was reversed' : 'answered in one order only'}`
    }
  }
  return {
    runs,
    state: 'settled',
    standings: graphStandings(shown, [...first, ...second]),
    judgedBy: ['models']
  }
}
