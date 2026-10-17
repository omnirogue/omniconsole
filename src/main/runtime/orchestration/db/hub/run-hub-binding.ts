import type { RunRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { validateHubBinding } from './hub-binding-validation'

export function bindRunToHub(
  this: OrchestrationDb,
  params: {
    runId: string
    hubTaskId: string
    hubStateRevision?: number
    hubNextAction?: string | null
  }
): RunRow {
  validateHubBinding(params)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRun(params.runId)
    if (!run || run.legacy) {
      throw new Error('An active-format run is required for explicit hub admission.')
    }
    if (run.hub_task_id && run.hub_task_id !== params.hubTaskId) {
      throw new Error(`Run ${run.id} is already bound to omnios card ${run.hub_task_id}.`)
    }
    const latest = this.db
      .prepare(`SELECT MAX(hub_state_revision) AS revision FROM (
      SELECT hub_state_revision FROM runs WHERE hub_task_id = ?
      UNION ALL SELECT hub_state_revision FROM tasks WHERE hub_task_id = ?)`)
      .get(params.hubTaskId, params.hubTaskId) as { revision: number | null }
    if (
      latest.revision != null &&
      params.hubStateRevision != null &&
      params.hubStateRevision < latest.revision
    ) {
      throw new Error('Stale hub revision; refresh the card through omnios.')
    }
    if (
      !run.hub_task_id &&
      this.db
        .prepare(
          `SELECT 1 FROM dispatch_contexts WHERE run_id = ? AND status IN ('pending', 'dispatched')
       UNION ALL SELECT 1 FROM worker_dispatches w JOIN dispatch_contexts d ON d.id = w.dispatch_id
       WHERE d.run_id = ? AND w.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown') LIMIT 1`
        )
        .get(run.id, run.id)
    ) {
      throw new Error(
        'Stop and confirm active workers before admitting this run to an omnios card.'
      )
    }
    const revision = params.hubStateRevision ?? latest.revision ?? null
    if (run.hub_task_id && params.hubNextAction !== undefined) {
      const projection = this.db
        .prepare(
          'SELECT hub_next_action FROM tasks WHERE run_id = ? AND hub_next_action IS NOT NULL LIMIT 1'
        )
        .get(run.id) as { hub_next_action: string } | undefined
      if (
        projection &&
        projection.hub_next_action !== params.hubNextAction &&
        (params.hubStateRevision == null || params.hubStateRevision === latest.revision)
      ) {
        throw new Error('Conflicting projection for the same hub revision; refresh through omnios.')
      }
    }
    // Why: explicit admission hands this Run's execution to the Hub, so its origin
    // escalates to hub_dispatched and local worker-start is fenced from here on.
    // The escalation trigger keeps the reverse (canonical -> local) impossible.
    this.db
      .prepare(
        `UPDATE runs SET hub_task_id = ?, hub_state_revision = ?, origin = 'hub_dispatched',
         updated_at = datetime('now') WHERE id = ?`
      )
      .run(params.hubTaskId, revision, run.id)
    this.db
      .prepare(
        `UPDATE tasks SET hub_task_id = ?, hub_state_revision = ?,
         hub_next_action = CASE WHEN ? THEN ? ELSE hub_next_action END WHERE run_id = ?`
      )
      .run(
        params.hubTaskId,
        revision,
        params.hubNextAction !== undefined ? 1 : 0,
        params.hubNextAction ?? null,
        run.id
      )
    this.db
      .prepare(
        `UPDATE dispatch_contexts SET hub_task_id = ?, hub_state_revision = ? WHERE run_id = ? AND hub_task_id IS NULL`
      )
      .run(params.hubTaskId, revision, run.id)
    this.db
      .prepare(
        `UPDATE worker_dispatches SET hub_task_id = ?, hub_state_revision = ? WHERE dispatch_id IN (SELECT id FROM dispatch_contexts WHERE run_id = ?) AND hub_task_id IS NULL`
      )
      .run(params.hubTaskId, revision, run.id)
    this.db.exec('COMMIT')
    return this.getRun(run.id) as RunRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type RunHubBindingMethods = { bindRunToHub: typeof bindRunToHub }

export function attachRunHubBinding(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { bindRunToHub })
}
