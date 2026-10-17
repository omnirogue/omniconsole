import type { GraphOutcome } from './graph/graph-plan-types'
import {
  graphSubstituteCallId,
  graphSubstituteSeatId,
  graphSubstitution
} from './graph/graph-seat-substitution'
import type {
  LocalWorkflowAttemptRecord,
  LocalWorkflowCallRecord
} from './local-workflow-call-projection'
import { graphCallSeatId } from './local-workflow-graph-projection'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { workflowCallLaunchFailure } from './workflow-launch-failure'
import { workflowFrozenSeat } from './workflow-program-snapshot'

type GraphSnapshot = LocalWorkflowHostSnapshot & {
  graph: NonNullable<LocalWorkflowHostSnapshot['graph']>
}

/**
 * Under seat rules, what the program saw for each planned call (graph-program.ts): the answer its
 * substitute gave, a failure at launch no seat took (lost), or, while its substitute is still to
 * settle, nothing yet. Substitute records themselves are not planned calls and are left out.
 */
export function graphSeatOutcomes(input: {
  snapshot: GraphSnapshot
  records: readonly LocalWorkflowCallRecord[]
  attempts: readonly LocalWorkflowAttemptRecord[]
  results: ReadonlyMap<string, unknown>
  outcomes: Map<string, GraphOutcome>
}): Map<string, GraphOutcome> {
  const { snapshot, records, attempts, results, outcomes } = input
  if (snapshot.graph.seatRules === undefined) {
    return outcomes
  }
  const settled = new Map(outcomes)
  for (const record of records) {
    const id = record.call_id
    if (graphSubstituteSeatId(id) !== undefined) {
      outcomes.delete(id)
      continue
    }
    const current = outcomes.get(id)
    if (current && 'value' in current) {
      continue
    }
    const failure = workflowCallLaunchFailure(attempts.filter((attempt) => attempt.call_id === id))
    const prefix = graphSubstituteCallId(id, '')
    const moved = records.find((entry) => entry.call_id.startsWith(prefix))
    if (!moved) {
      if (current && 'failed' in current && !current.skipped && failure) {
        outcomes.set(id, { ...current, lost: failure })
      }
      continue
    }
    const plannedSeat = graphCallSeatId(snapshot, id)
    const from = plannedSeat === undefined ? undefined : workflowFrozenSeat(snapshot, plannedSeat)
    const to = workflowFrozenSeat(snapshot, moved.call_id.slice(prefix.length))
    const reason = failure ?? 'it could not start'
    const substitute = from && to ? { substitute: graphSubstitution(id, from, to, reason) } : {}
    if (results.has(moved.call_id)) {
      outcomes.set(id, { value: results.get(moved.call_id), ...substitute })
    } else if (settled.get(moved.call_id)) {
      outcomes.set(id, { failed: true, lost: reason, ...substitute })
    } else {
      // Its substitute is still running, or waits to: the step waits on it too.
      outcomes.delete(id)
    }
  }
  return outcomes
}
