import type Database from '../../sqlite/sync-database'
import {
  WORKFLOW_SUPERSEDED_CALL_SQL,
  workflowSettlesExhaustedCalls,
  workflowSettlesSupersededCalls
} from './workflow-checkpoint-admission'
import { graphHasRetryableCalls, graphSpecOfExecution } from './graph/graph-checkpoint'
import { GraphJevStore, graphFindHasRetryableScreenFailure } from './graph/graph-jev-store'
import { graphHarvestHasRetryableFailure } from './graph/graph-github-harvest'
import { graphWebHasRetryableFailure } from './graph/graph-web-sources'
import { workflowWebStarted } from './workflow-web-starts'

/**
 * Legacy programs need every call, so every unresolved call must have room under its original
 * per-call attempt ceiling. A settling program replays exhausted calls as lasting nulls, so it
 * can retry whenever one unresolved call still has room and none is quarantined. Council 6 also
 * replays answers and rankings a later stage was keyed without as nulls, so they never count.
 */
export function hasWorkflowRetryableCalls(
  db: Database.Database,
  executionId: string,
  attemptLimit: number
): boolean {
  const execution = db
    .prepare('SELECT snapshot_json FROM local_workflow_executions WHERE id=?')
    .get(executionId) as { snapshot_json: string } | undefined
  const graph = execution && graphSpecOfExecution(execution.snapshot_json)
  if (graph) {
    return (
      graphHasRetryableCalls(db, executionId, graph, attemptLimit) ||
      // Find's screen/JEV/facts/check calls never appear in local_workflow_calls (they are
      // resolved in-process, not by an agent attempt), so a transient screen failure with no
      // cache written is invisible to the check above. Retry is worth offering for it too.
      graphFindHasRetryableScreenFailure(graph, GraphJevStore.forExecution(executionId)) ||
      // A transient GitHub search failure records nothing at all, so Retry really does search again.
      graphHarvestHasRetryableFailure(
        graph,
        GraphJevStore.forExecution(executionId, undefined, 'github-harvest.json')
      ) ||
      graphWebHasRetryableFailure(
        execution.snapshot_json,
        GraphJevStore.forExecution(executionId, undefined, 'web-sources.json'),
        GraphJevStore.forExecution(executionId, undefined, 'web-calls.json'),
        workflowWebStarted(db, executionId)
      )
    )
  }
  const superseded = execution && workflowSettlesSupersededCalls(execution.snapshot_json) ? 1 : 0
  const row = db
    .prepare(`SELECT COUNT(*) AS unresolved,
      SUM(CASE WHEN c.quarantined=1 OR
        (SELECT COUNT(*) FROM local_workflow_attempts AS a
          WHERE a.execution_id=c.execution_id AND a.call_id=c.call_id) >= ?
        THEN 1 ELSE 0 END) AS exhausted,
      SUM(CASE WHEN c.quarantined=1 THEN 1 ELSE 0 END) AS quarantined
      FROM local_workflow_calls AS c
      WHERE c.execution_id=? AND c.accepted_attempt_id IS NULL
        AND (?=0 OR c.quarantined=1 OR NOT ${WORKFLOW_SUPERSEDED_CALL_SQL})`)
    .get(attemptLimit, executionId, superseded) as {
    unresolved: number
    exhausted: number | null
    quarantined: number | null
  }
  if (execution && workflowSettlesExhaustedCalls(execution.snapshot_json)) {
    return row.unresolved > (row.exhausted ?? 0) && !row.quarantined
  }
  return row.unresolved > 0 && row.exhausted === 0
}
