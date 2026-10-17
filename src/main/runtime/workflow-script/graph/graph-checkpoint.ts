import type Database from '../../../sqlite/sync-database'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  planWorkflowCalls,
  workflowFinishReserve,
  workflowTerminalCall
} from '../../../../shared/workflow-graph-topology'
import { graphCallSuperseded, graphSpecFromCheckpoint } from './graph-supersede'

/** Why a call outside the final step gets no agent once the run is finishing. */
export const GRAPH_FINISHING_REFUSAL = 'No new agents: this run is finishing with what it has'

/**
 * Checkpoint rules for workflow graph runs, next to the Council 6 and Discover 7 rules in
 * workflow-checkpoint-admission.ts. The graph planner only reports success once every call it
 * planned has settled, so completion needs no call-by-call count; what the store must still
 * enforce is that a failure a later step was built without stays final.
 */
function recordedCallIds(db: Database.Database, executionId: string): string[] {
  return (
    db
      .prepare('SELECT call_id FROM local_workflow_calls WHERE execution_id=?')
      .all(executionId) as { call_id: string }[]
  ).map((row) => row.call_id)
}

export function graphSpecOfExecution(snapshotJson: string): WorkflowSpec | undefined {
  return graphSpecFromCheckpoint(snapshotJson)
}

/**
 * Whether the run admits no new call outside its final step: Finish now lowered its call limit,
 * or Max agents was reached. The final step's calls stay reserved either way.
 */
export function graphAdmissionClosed(
  spec: WorkflowSpec,
  callLimit: number,
  recordedCallIds: readonly string[]
): boolean {
  const finish = workflowFinishReserve(spec)
  // Only a lowered limit closes admission: an uncapped run that recorded every call is not ending.
  if (!finish || callLimit >= planWorkflowCalls(spec).total) {
    return false
  }
  const others = recordedCallIds.filter((callId) => !workflowTerminalCall(spec, callId)).length
  return others >= callLimit - finish.reserve
}

/**
 * For the view: whether admission is closed, and whether Finish now is still open (the run can
 * finish early, has not closed, and no call that ends it has started).
 */
export function graphFinishState(
  spec: WorkflowSpec,
  callLimit: number,
  recorded: readonly string[]
): { closed: boolean; open: boolean } {
  const finish = !!workflowFinishReserve(spec)
  const closed = finish && graphAdmissionClosed(spec, callLimit, recorded)
  const started = recorded.some((callId) => workflowTerminalCall(spec, callId))
  return { closed, open: finish && !closed && !started }
}

/**
 * Refuses a new attempt for a call whose result a later step was already built without, and a
 * new call outside the final step once the run is finishing.
 */
export function assertGraphAttemptAdmissible(
  db: Database.Database,
  execution: { id: string; call_limit: number },
  spec: WorkflowSpec,
  callId: string,
  newCall: boolean
): void {
  const recorded = recordedCallIds(db, execution.id)
  if (graphCallSuperseded(spec, callId, recorded)) {
    throw new Error('A later step was already built without this result')
  }
  if (
    newCall &&
    !workflowTerminalCall(spec, callId) &&
    graphAdmissionClosed(spec, execution.call_limit, recorded)
  ) {
    throw new Error(GRAPH_FINISHING_REFUSAL)
  }
}

/** A graph run completes around failed calls; only corrupt (quarantined) evidence blocks it. */
export function graphHasQuarantinedCalls(db: Database.Database, executionId: string): boolean {
  return !!db
    .prepare(
      'SELECT 1 AS found FROM local_workflow_calls WHERE execution_id=? AND quarantined=1 LIMIT 1'
    )
    .get(executionId)
}

/**
 * Retry is worth offering when a failed call no later step was built without still has a
 * persisted attempt, and no evidence is quarantined.
 */
export function graphHasRetryableCalls(
  db: Database.Database,
  executionId: string,
  spec: WorkflowSpec,
  attemptLimit: number
): boolean {
  if (graphHasQuarantinedCalls(db, executionId)) {
    return false
  }
  const recorded = recordedCallIds(db, executionId)
  const open = db
    .prepare(
      `SELECT c.call_id AS callId, (SELECT COUNT(*) FROM local_workflow_attempts AS a
        WHERE a.execution_id=c.execution_id AND a.call_id=c.call_id) AS attempts
        FROM local_workflow_calls AS c WHERE c.execution_id=? AND c.accepted_attempt_id IS NULL`
    )
    .all(executionId) as { callId: string; attempts: number }[]
  return open.some(
    (call) => call.attempts < attemptLimit && !graphCallSuperseded(spec, call.callId, recorded)
  )
}
