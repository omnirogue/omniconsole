import type { OrchestrationDb } from '../orchestration-db'

export function applyHubBindingMigration(this: OrchestrationDb, current: number): void {
  if (current >= 31) {
    return
  }
  for (const table of [
    'runs',
    'tasks',
    'dispatch_contexts',
    'worker_dispatches',
    'remote_dispatch_attachments'
  ]) {
    if (!this.hasColumn(table, 'hub_task_id')) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN hub_task_id TEXT`)
    }
    if (!this.hasColumn(table, 'hub_state_revision')) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN hub_state_revision INTEGER`)
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${table}_hub_task ON ${table}(hub_task_id)
        WHERE hub_task_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_hub_task
      BEFORE UPDATE OF hub_task_id ON ${table}
      WHEN OLD.hub_task_id IS NOT NULL AND NEW.hub_task_id IS NOT OLD.hub_task_id
      BEGIN
        SELECT RAISE(ABORT, 'Hub card binding is immutable; use omnios for business changes.');
      END;
    `)
  }
  if (!this.hasColumn('tasks', 'hub_next_action')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN hub_next_action TEXT')
  }
  if (!this.hasColumn('decision_gates', 'decision_scope')) {
    this.db.exec('ALTER TABLE decision_gates ADD COLUMN decision_scope TEXT')
  }
  this.db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_tasks_inherit_hub_card
    AFTER INSERT ON tasks
    WHEN (SELECT hub_task_id FROM runs WHERE id = NEW.run_id) IS NOT NULL
    BEGIN
      SELECT CASE WHEN NEW.hub_task_id IS NOT NULL
        AND NEW.hub_task_id IS NOT (SELECT hub_task_id FROM runs WHERE id = NEW.run_id)
        THEN RAISE(ABORT, 'Task must inherit its run hub card.') END;
      UPDATE tasks SET
        hub_task_id = (SELECT hub_task_id FROM runs WHERE id = NEW.run_id),
        hub_state_revision = (SELECT hub_state_revision FROM runs WHERE id = NEW.run_id)
      WHERE id = NEW.id;
    END;
  `)
}
