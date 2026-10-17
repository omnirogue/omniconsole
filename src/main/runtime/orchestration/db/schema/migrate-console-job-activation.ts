import type { OrchestrationDb } from '../orchestration-db'

/** Why: `console_job` alone only says a binding of the right shape was stored.
 *  The activation receipt is what the BFF returned when the signed-in person
 *  activated the approved job, and only the main-only console launch path can
 *  supply it -- the public `orchestration.runCreate` RPC refuses console job
 *  parameters outright. Storing it beside the binding, insert-only and
 *  immutable, gives the local-start carve-out admission evidence to read
 *  instead of a request body it cannot authenticate. */
export function applyConsoleJobActivationMigration(this: OrchestrationDb, current: number): void {
  if (current >= 35) {
    return
  }
  if (!this.hasColumn('runs', 'console_job_activation')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN console_job_activation TEXT')
  }
  this.db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_activation_insert
    BEFORE INSERT ON runs
    WHEN NEW.console_job_activation IS NOT NULL
    BEGIN
      SELECT CASE WHEN NEW.console_job IS NULL
        OR json_extract(NEW.console_job_activation, '$.jobId')
             IS NOT json_extract(NEW.console_job, '$.jobId')
        OR json_type(NEW.console_job_activation, '$.activationId') IS NOT 'text'
        OR json_type(NEW.console_job_activation, '$.jobDigest') IS NOT 'text'
        THEN RAISE(ABORT, 'A console job activation receipt belongs to its own admitted job.') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_console_job_activation_immutable
    BEFORE UPDATE OF console_job_activation ON runs
    WHEN NEW.console_job_activation IS NOT OLD.console_job_activation
    BEGIN
      SELECT RAISE(ABORT, 'The console job activation receipt is committed at run creation.');
    END;
  `)
}
