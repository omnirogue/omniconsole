import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { isIndependentLineage, type ModelLineage } from '../../../../shared/model-lineage'
import { graphSubstituteSeatId } from './graph-seat-substitution'
import type { GraphItem } from './graph-items'
import { graphTally, type GraphTally, type GraphVerdict } from './graph-parse'
import type { GraphScope } from './graph-scope'

/** The lineage of the seat that made a call, from its id (`step[/…]/a<n>`). */
function callLineage(scope: GraphScope, callId: string): ModelLineage {
  const outcome = scope.outcomes.get(callId)
  const actual = graphSubstituteSeatId(callId) ?? outcome?.substitute?.seatId
  if (actual) {
    return (
      [...scope.config.seats, ...(scope.config.spareSeats ?? [])].find((seat) => seat.id === actual)
        ?.lineage ?? 'unknown'
    )
  }
  const parts = callId.split('/')
  const agent = /^a(\d+)$/.exec(parts.at(-1) ?? '')
  const seatId = agent ? scope.config.agentSeats[parts[0]!]?.[Number(agent[1])] : undefined
  return scope.config.seats.find((seat) => seat.id === seatId)?.lineage ?? 'unknown'
}

/**
 * The agent that reviews an item first, and whether it is independent of every finder of it:
 * with `crossFamily`, the step's first agent whose family is known and differs from each finder's
 * (merged reports included). None qualifying, or no `crossFamily`: agent 0, not independent.
 */
export function graphFirstReview(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem | undefined
): { index: number; independent: boolean } {
  if (!step.escalate?.crossFamily || !item) {
    return { index: 0, independent: false }
  }
  const finders = [item.sourceCallId, ...(item.alsoFrom ?? [])].map((id) => callLineage(scope, id))
  const index = step.agents.findIndex((_, agentIndex) => {
    const seatId = scope.seatFor(step, agentIndex)
    const lineage = scope.config.seats.find((seat) => seat.id === seatId)?.lineage ?? 'unknown'
    return finders.every((finder) => isIndependentLineage(lineage, finder))
  })
  return index === -1 ? { index: 0, independent: false } : { index, independent: true }
}

/** Whether an agent of the step is of a known family different from every finder of the item. */
export function graphReviewerIndependent(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem,
  agentIndex: number
): boolean {
  const lineage = seatLineage(scope, step, agentIndex, item)
  return [item.sourceCallId, ...(item.alsoFrom ?? [])].every((id) =>
    isIndependentLineage(lineage, callLineage(scope, id))
  )
}

export function graphFirstReviewer(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem | undefined
): number {
  return graphFirstReview(scope, step, item).index
}

/**
 * The agent that reviews an item in place of a first review that gave no answer: the step's first
 * agent on another provider than the first reviewer's, since an outage takes a provider's every
 * seat, and with `crossFamily` independent of every finder too. Undefined when none qualifies.
 */
export function graphStandInReviewer(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem
): number | undefined {
  const first = graphFirstReview(scope, step, item).index
  const provider = (agentIndex: number) => {
    const seatId = scope.seatFor(step, agentIndex)
    return scope.config.seats.find((seat) => seat.id === seatId)?.agent
  }
  const index = step.agents.findIndex(
    (_, agentIndex) =>
      provider(agentIndex) !== provider(first) &&
      (!step.escalate?.crossFamily || graphReviewerIndependent(scope, step, item, agentIndex))
  )
  return index === -1 ? undefined : index
}

function seatLineage(
  scope: GraphScope,
  step: WorkflowStep,
  agentIndex: number,
  item?: GraphItem
): ModelLineage {
  const call =
    item &&
    scope.calls.findLast(
      (call) =>
        call.stepId === step.id &&
        call.agentIndex === agentIndex &&
        call.id.includes(`/${item.key}/`)
    )
  if (call) {
    return callLineage(scope, call.id)
  }
  const seatId = scope.seatFor(step, agentIndex)
  return scope.config.seats.find((seat) => seat.id === seatId)?.lineage ?? 'unknown'
}

/**
 * A reviewed item's verdict. With `crossFamily` a majority is a confirmation only when a family
 * independent of every finder passed it, or two known families did; a pass from one family
 * alone (an all-one-family roster, or an escalation capped or finished early) stays unverified.
 */
export function graphReviewTally(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem,
  votes: readonly (GraphVerdict | null)[],
  voters: readonly number[],
  capped = false
): { tally: GraphTally; crossChecked?: true; sameFamilyOnly?: true } {
  const tally = graphTally(votes)
  if (capped && tally === 'refuted' && votes.filter(Boolean).length === 1) {
    return { tally: 'unverified' }
  }
  if (!step.escalate?.crossFamily || tally !== 'confirmed') {
    return { tally }
  }
  const passed = votes.flatMap((vote, index) => (vote === 'pass' ? [voters[index] ?? index] : []))
  const families = new Set(
    passed
      .map((agent) => seatLineage(scope, step, agent, item))
      .filter((lineage) => lineage !== 'unknown')
  )
  const independent = passed.some((agent) => graphReviewerIndependent(scope, step, item, agent))
  return independent || families.size >= 2
    ? { tally, crossChecked: true }
    : { tally: 'unverified', sameFamilyOnly: true }
}
