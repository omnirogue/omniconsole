import type { OrchestrationDb } from '../orchestration-db'

/** A worker Task is bound before workerStart so a fast worker cannot outrun its result gate. */
export function applyWorkflowWorkerCallsMigration(this: OrchestrationDb, current: number): void {
  if (current >= 40) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS local_workflow_working_runs (
      execution_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      coordinator_handle TEXT NOT NULL,
      run_request_id TEXT NOT NULL UNIQUE,
      run_id TEXT UNIQUE,
      source_base TEXT NOT NULL,
      source_diff_digest TEXT NOT NULL,
      result_json TEXT,
      result_digest TEXT,
      finished_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('prepared','starting','running','completed','failed','unverifiable'))
    );
    CREATE TABLE IF NOT EXISTS local_workflow_worker_calls (
      execution_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      start_request_id TEXT NOT NULL UNIQUE,
      dispatch_id TEXT UNIQUE,
      workspace_id TEXT NOT NULL,
      child_worktree_id TEXT,
      input_digest TEXT NOT NULL,
      source_base TEXT NOT NULL,
      source_diff_digest TEXT NOT NULL,
      capability_revision TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      semantic_json TEXT NOT NULL,
      semantic_digest TEXT NOT NULL,
      result_json TEXT,
      result_digest TEXT,
      artifact_digest TEXT,
      result_revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('prepared','starting','running','accepted','failed','unverifiable')),
      PRIMARY KEY (execution_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_local_workflow_worker_calls_run
      ON local_workflow_worker_calls(run_id);
  `)
}
