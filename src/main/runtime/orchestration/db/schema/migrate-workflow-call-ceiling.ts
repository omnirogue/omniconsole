import type { OrchestrationDb } from '../orchestration-db'
import type Database from '../../../../sqlite/sync-database'

/** The call_limit ceiling the current workflow table enforces, if the table exists. */
export function workflowTableCallCeiling(db: Database.Database): number | undefined {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_workflow_executions'"
    )
    .get() as { sql: string } | undefined
  const match = row && /call_limit\s+BETWEEN\s+1\s+AND\s+(\d+)/i.exec(row.sql)
  return match ? Number(match[1]) : undefined
}

/**
 * v41: Discover revision 7 may plan up to 400 calls (scout, finders, three verifiers per finding
 * and the rank reserve). SQLite CHECK constraints need a table copy; this runs inside the
 * enclosing BEGIN IMMEDIATE, so a failed copy leaves v40 intact. A table that already allows 400
 * calls (a pre-release build stored this step as v40) is left as it is.
 */
export function applyWorkflowCallCeilingMigration(this: OrchestrationDb, current: number): void {
  if (current >= 41 || (workflowTableCallCeiling(this.db) ?? 0) >= 400) {
    return
  }
  this.db.exec(`
    CREATE TABLE local_workflow_executions_v41 (
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
      call_limit INTEGER NOT NULL CHECK (call_limit BETWEEN 1 AND 400),
      budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
      budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved >= 0),
      UNIQUE (conversation_id, request_id)
    );
    INSERT INTO local_workflow_executions_v41
      (id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,sequence,attempt_limit,call_limit,budget_limit,budget_reserved)
    SELECT id,conversation_id,request_id,snapshot_json,snapshot_digest,preset,fence,state,sequence,attempt_limit,call_limit,budget_limit,budget_reserved
    FROM local_workflow_executions ORDER BY rowid;
    DROP TABLE local_workflow_executions;
    ALTER TABLE local_workflow_executions_v41 RENAME TO local_workflow_executions;
  `)
}
