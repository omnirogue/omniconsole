import type { OrchestrationDb } from '../orchestration-db'

/** Why a column and not a parsed `last_error`: a failed readiness wait wrote the startup prompt's
 *  machine id only inside the sentence "Agent startup blocked: <id>", so the session recovery ladder
 *  had to take it back out of prose to choose a remedy. Nullable and never backfilled: a row written
 *  by an older build keeps NULL, and its reader falls back to the sentence. */
export function applyWorkerStartupBlockerMigration(this: OrchestrationDb, current: number): void {
  if (current >= 36) {
    return
  }
  if (!this.hasColumn('worker_dispatches', 'startup_blocker')) {
    this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN startup_blocker TEXT')
  }
}
