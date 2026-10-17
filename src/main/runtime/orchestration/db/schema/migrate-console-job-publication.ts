import type { OrchestrationDb } from '../orchestration-db'

function applyPublicationColumns(this: OrchestrationDb): void {
  if (!this.hasColumn('runs', 'console_job')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN console_job TEXT')
  }
  if (!this.hasColumn('runs', 'console_job_principal')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN console_job_principal TEXT')
  }
  this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_console_job_attempt ON runs(
      console_job_principal, json_extract(console_job, '$.jobId'),
      json_extract(console_job, '$.attempt'), json_extract(console_job, '$.leaseGeneration')
    ) WHERE console_job IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS trg_runs_immutable_console_job
    BEFORE UPDATE OF console_job, console_job_principal ON runs
    WHEN NEW.console_job IS NOT OLD.console_job
      OR NEW.console_job_principal IS NOT OLD.console_job_principal
    BEGIN
      SELECT RAISE(ABORT, 'Console job correlation must be committed at run creation.');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_card
    BEFORE INSERT ON runs
    WHEN NEW.console_job IS NOT NULL
    BEGIN
      SELECT CASE WHEN json_extract(NEW.console_job, '$.taskId') IS NOT NEW.hub_task_id
        OR NEW.console_job_principal IS NULL
        THEN RAISE(ABORT, 'Console job correlation requires its card and publication principal.') END;
    END;
    CREATE TABLE IF NOT EXISTS console_job_publications (
      observation_id TEXT PRIMARY KEY,
      journal_sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      principal TEXT NOT NULL,
      payload TEXT NOT NULL,
      acknowledged_at TEXT,
      retry_blocked INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_console_job_publications_pending
      ON console_job_publications(journal_sequence) WHERE acknowledged_at IS NULL;
  `)
}

export function applyConsoleJobPublicationMigration(this: OrchestrationDb, current: number): void {
  if (current < 32) {
    applyPublicationColumns.call(this)
  }
  if (current >= 33) {
    return
  }
  for (const column of ['console_job_dispatch_id', 'console_job_start_receipt']) {
    if (!this.hasColumn('runs', column)) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
    }
  }
  this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_console_job_dispatch
      ON runs(console_job_dispatch_id) WHERE console_job_dispatch_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_start_insert
    BEFORE INSERT ON runs
    WHEN NEW.console_job_dispatch_id IS NOT NULL OR NEW.console_job_start_receipt IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'Console job start requires its existing Run and Dispatch.');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_dispatch
    BEFORE UPDATE OF console_job_dispatch_id ON runs
    WHEN NEW.console_job_dispatch_id IS NOT OLD.console_job_dispatch_id
    BEGIN
      SELECT CASE WHEN OLD.console_job_dispatch_id IS NOT NULL
        OR NEW.console_job_dispatch_id IS NULL
        OR json_type(NEW.console_job, '$.claim') IS NOT 'object'
        OR NOT EXISTS (
          SELECT 1 FROM dispatch_contexts d JOIN tasks t ON t.id = d.task_id
          WHERE d.id = NEW.console_job_dispatch_id AND d.run_id = NEW.id AND t.run_id = NEW.id
            AND d.hub_task_id = NEW.hub_task_id AND t.hub_task_id = NEW.hub_task_id
        ) THEN RAISE(ABORT, 'The console job claim is pinned to one admitted Dispatch.') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_start_receipt
    BEFORE UPDATE OF console_job_start_receipt ON runs
    WHEN NEW.console_job_start_receipt IS NOT OLD.console_job_start_receipt
    BEGIN
      SELECT CASE WHEN OLD.console_job_start_receipt IS NOT NULL
        OR NEW.console_job_start_receipt IS NULL
        OR NEW.console_job_dispatch_id IS NULL
        OR json_type(NEW.console_job, '$.claim') IS NOT 'object'
        OR json_type(NEW.console_job, '$.sessionId') IS NOT NULL
        OR json_type(NEW.console_job, '$.attemptId') IS NOT NULL
        OR json_extract(NEW.console_job_start_receipt, '$.dispatchId') IS NOT NEW.console_job_dispatch_id
        OR json_type(NEW.console_job_start_receipt, '$.sessionId') IS NOT 'text'
        OR length(json_extract(NEW.console_job_start_receipt, '$.sessionId')) = 0
        OR json_type(NEW.console_job_start_receipt, '$.attemptId') IS NOT 'text'
        OR length(json_extract(NEW.console_job_start_receipt, '$.attemptId')) = 0
        THEN RAISE(ABORT, 'The console job start receipt is immutable on its pinned Dispatch.') END;
    END;
  `)
}
