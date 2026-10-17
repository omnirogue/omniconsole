import type { OrchestrationDb } from '../orchestration-db'

/** Why: `hub_task_id` says which card a Run reports to, never who owns its
 *  execution. A Hub-dispatched canonical run (server-issued console job binding
 *  or the workerPrepare claim) may only be started by Hub admission; a run a
 *  signed-in person bound to a card from this dispatcher is started locally and
 *  only reports to the card. The stored origin is what tells the fence apart.
 *  Existing rows are classified from the evidence they already carry: a console
 *  job binding means Hub-dispatched, a bare card means locally bound, neither
 *  means personal. */
export function applyRunOriginMigration(this: OrchestrationDb, current: number): void {
  if (current >= 34) {
    return
  }
  if (!this.hasColumn('runs', 'origin')) {
    this.db.exec(`ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'personal'`)
    this.db.exec(`
      UPDATE runs SET origin = CASE
        WHEN console_job IS NOT NULL THEN 'hub_dispatched'
        WHEN hub_task_id IS NOT NULL THEN 'local_bound'
        ELSE 'personal'
      END;
    `)
  }
  this.db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runs_origin_admission
    BEFORE INSERT ON runs
    BEGIN
      SELECT CASE WHEN NEW.origin NOT IN ('hub_dispatched', 'local_bound', 'personal')
        OR (NEW.console_job IS NOT NULL AND NEW.origin IS NOT 'hub_dispatched')
        OR (NEW.origin IS 'personal' AND NEW.hub_task_id IS NOT NULL)
        OR (NEW.origin IS NOT 'personal' AND NEW.hub_task_id IS NULL)
        THEN RAISE(ABORT, 'A run origin must match its card binding and console job admission.') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_origin_escalation_only
    BEFORE UPDATE OF origin ON runs
    WHEN NEW.origin IS NOT OLD.origin
    BEGIN
      SELECT CASE WHEN OLD.origin IS 'hub_dispatched'
        OR NEW.origin IS NOT 'hub_dispatched'
        OR NEW.hub_task_id IS NULL
        THEN RAISE(ABORT, 'A run origin only escalates to hub_dispatched at Hub admission.') END;
    END;
  `)
}
