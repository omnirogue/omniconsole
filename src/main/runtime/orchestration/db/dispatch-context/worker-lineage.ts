import type { OrchestrationDb } from '../orchestration-db'

export type WorkerLineageRow = {
  dispatch_id: string
  resource_owner_dispatch_id: string | null
  resource_host_scope: string | null
  resource_process_incarnation?: string | null
  retained_by_user: number | null
  parent_pane_key: string | null
  parent_handle: string | null
  child_pane_key: string | null
  child_handle: string | null
  environment_id: string | null
  remote_terminal: string | null
  dispatched_at: string
}

// Why a window and a cap: the sidebar polls this; older workers' rows have long been put away.
const LINEAGE_WINDOW = '-30 days'
const LINEAGE_LIMIT = 5000

/** Every recent dispatch with its owner and pane or handle, oldest first. */
export function listWorkerLineage(this: OrchestrationDb): WorkerLineageRow[] {
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              r.owner_dispatch_id AS resource_owner_dispatch_id,
              r.host_scope AS resource_host_scope,
              r.process_incarnation AS resource_process_incarnation,
              COALESCE(r.ownership_state = 'user_owned' OR
                       (r.release_state = 'retained' AND r.retained_reason IN ('user_requested', 'user_takeover')), 0)
                AS retained_by_user,
              t.created_by_pane_key AS parent_pane_key,
              t.created_by_terminal_handle AS parent_handle,
              d.assignee_pane_key AS child_pane_key,
              COALESCE(d.assignee_handle, w.agent_terminal_handle) AS child_handle,
              f.environment_id AS environment_id,
              f.remote_terminal_handle AS remote_terminal,
              d.created_at AS dispatched_at
       FROM dispatch_contexts d
       JOIN tasks t ON t.id = d.task_id
       LEFT JOIN federated_dispatches f ON f.dispatch_id = d.id
       LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
       LEFT JOIN worker_terminal_resources r
         -- Pane alone can be reused; only an exact pane and process incarnation confer action identity.
         ON d.process_incarnation IS NOT NULL
            AND d.assignee_pane_key IS NOT NULL
            AND r.process_incarnation = d.process_incarnation
            AND r.pane_key = d.assignee_pane_key
            AND (SELECT COUNT(*) FROM worker_terminal_resources r2
                  WHERE r2.process_incarnation = d.process_incarnation
                    AND r2.pane_key = d.assignee_pane_key) = 1
       WHERE d.created_at >= datetime('now', ?)
       ORDER BY d.rowid DESC
       LIMIT ?`
    )
    .all(LINEAGE_WINDOW, LINEAGE_LIMIT) as WorkerLineageRow[]
  return rows.toReversed()
}

export type WorkerLineageMethods = {
  listWorkerLineage: typeof listWorkerLineage
}

export function attachWorkerLineage(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { listWorkerLineage })
}
