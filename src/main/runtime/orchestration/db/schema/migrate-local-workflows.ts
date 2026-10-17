import type { OrchestrationDb } from '../orchestration-db'

export function applyLocalWorkflowMigration(this: OrchestrationDb, current: number): void {
  if (current >= 37) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS local_workflow_executions (
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
      call_limit INTEGER NOT NULL CHECK (call_limit BETWEEN 1 AND 28),
      budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
      budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved >= 0),
      UNIQUE (conversation_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS local_workflow_calls (
      execution_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      result_json TEXT,
      result_digest TEXT,
      accepted_attempt_id TEXT,
      quarantined INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (execution_id, call_id)
    );
    CREATE TABLE IF NOT EXISTS local_workflow_attempts (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
      fence INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'accepted', 'failed', 'cancelled', 'unverifiable')),
      reservation INTEGER NOT NULL CHECK (reservation >= 0),
      receipt_json TEXT,
      UNIQUE (execution_id, call_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_local_workflow_attempts_execution
      ON local_workflow_attempts(execution_id, call_id);
  `)
}
