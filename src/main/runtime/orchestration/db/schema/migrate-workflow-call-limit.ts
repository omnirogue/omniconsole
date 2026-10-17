import type { OrchestrationDb } from '../orchestration-db'
import { workflowTableCallCeiling } from './migrate-workflow-call-ceiling'

/** SQLite CHECK constraints require a table copy; migrate within the enclosing BEGIN IMMEDIATE. */
export function applyWorkflowCallLimitMigration(this: OrchestrationDb, current: number): void {
  // A skew repair can replay this step on a v41 table; copying rows above 30 calls back into
  // the 30-call table would fail the CHECK and roll the whole migration back.
  if (current >= 39 || (workflowTableCallCeiling(this.db) ?? 0) > 30) {
    return
  }
  this.db.exec(`
    CREATE TABLE local_workflow_executions_v39 (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      preset TEXT NOT NULL CHECK (preset IN ('council', 'discover')),
      fence INTEGER NOT NULL CHECK (fence > 0),
      state TEXT NOT NULL CHECK (state IN ('running', 'pausing', 'paused', 'stopping', 'cancelled', 'failed', 'completed', 'recovery_failed')),
      sequence INTEGER NOT NULL DEFAULT 0,
      attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 3),
      call_limit INTEGER NOT NULL CHECK (call_limit BETWEEN 1 AND 30),
      budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
      budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved >= 0),
      UNIQUE (conversation_id, request_id)
    );
    INSERT INTO local_workflow_executions_v39
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,sequence,attempt_limit,call_limit,budget_limit,budget_reserved)
    SELECT id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,sequence,attempt_limit,call_limit,budget_limit,budget_reserved
    FROM local_workflow_executions ORDER BY rowid;
    DROP TABLE local_workflow_executions;
    ALTER TABLE local_workflow_executions_v39 RENAME TO local_workflow_executions;
  `)
}
