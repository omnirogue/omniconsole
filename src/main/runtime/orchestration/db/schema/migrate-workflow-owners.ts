import type { OrchestrationDb } from '../orchestration-db'

export function applyWorkflowOwnerMigration(this: OrchestrationDb, current: number): void {
  if (current >= 38) {
    return
  }
  this.db.exec(`CREATE TABLE IF NOT EXISTS local_workflow_owners (
    execution_id TEXT PRIMARY KEY,
    owner_json TEXT NOT NULL,
    owner_digest TEXT NOT NULL
  )`)
}
