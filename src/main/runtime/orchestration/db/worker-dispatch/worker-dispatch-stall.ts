// ─── Settling a dispatch nobody else will ever settle ────────────────────────
// Why: `timeoutMs` was recorded on every worker-start and then enforced by nothing. A worker whose
// agent died after its prompt landed left `state='ready', stage='input_accepted', last_error=NULL`
// forever, so the Task stayed `dispatched`, the step stayed queued and the person saw silence.
// These two statements are the durable half of the fix: read the rows a watchdog may judge, and
// settle exactly one of them under a guard so a live start/stop path can never lose a race.

import type { WorkerDispatchRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskDependents } from '../tasks/task-dependency-stranding'
import { exposeUtcTimestamp } from '../utc-timestamp'

/** One `ready` dispatch and everything a stall verdict needs, with no second query per row. */
export type WatchedWorkerDispatchRow = {
  dispatch_id: string
  task_id: string
  stage: string
  /** ISO-8601 UTC (`exposeUtcTimestamp`), so `Date.parse` is exact regardless of local zone. */
  updated_at: string
  /** The readiness budget this very worker-start recorded, or null when it recorded none. */
  timeout_ms: number | null
  agent_terminal_handle: string | null
  assignee_pane_key: string | null
  /** The worker's last lifecycle heartbeat, ISO-8601 UTC, or null when it has sent none. */
  last_heartbeat_at: string | null
  /** The runtime that started this worker; a different current runtime means a restart. */
  runtime_epoch: string | null
}

const WATCHED_DISPATCH_SCAN_LIMIT = 500

function readRecordedTimeoutMs(startOptions: string): number | null {
  try {
    const parsed: unknown = JSON.parse(startOptions)
    const value =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { timeoutMs?: unknown }).timeoutMs
        : undefined
    // Why: only the dispatch's OWN recorded budget may fail it — never a default invented here.
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Dispatches whose outcome is still open and whose worker owns the turn: `state='ready'` means the
 * instruction was accepted, so nothing else is going to report for it. `starting` is deliberately
 * excluded (the in-flight worker-start call owns it and its own guards would collide), as are
 * `start_unknown` and every terminal state (recovery and stop paths own those).
 */
export function listWatchedWorkerDispatches(
  this: OrchestrationDb,
  limit = WATCHED_DISPATCH_SCAN_LIMIT
): WatchedWorkerDispatchRow[] {
  const rows = this.db
    .prepare(
      `SELECT w.dispatch_id, w.stage, w.start_options, w.updated_at, w.runtime_epoch,
              w.agent_terminal_handle, d.assignee_pane_key, d.task_id, d.last_heartbeat_at
         FROM worker_dispatches w
         JOIN dispatch_contexts d ON d.id = w.dispatch_id
        WHERE w.state = 'ready' AND d.status IN ('pending', 'dispatched')
        ORDER BY w.updated_at ASC
        LIMIT ?`
    )
    .all(limit) as {
    dispatch_id: string
    stage: string
    start_options: string
    updated_at: string
    agent_terminal_handle: string | null
    assignee_pane_key: string | null
    task_id: string
    last_heartbeat_at: string | null
    runtime_epoch: string | null
  }[]
  return rows.map((row) => ({
    dispatch_id: row.dispatch_id,
    task_id: row.task_id,
    stage: row.stage,
    updated_at: exposeUtcTimestamp(row.updated_at) ?? row.updated_at,
    timeout_ms: readRecordedTimeoutMs(row.start_options),
    agent_terminal_handle: row.agent_terminal_handle,
    assignee_pane_key: row.assignee_pane_key,
    last_heartbeat_at: row.last_heartbeat_at
      ? (exposeUtcTimestamp(row.last_heartbeat_at) ?? row.last_heartbeat_at)
      : null,
    runtime_epoch: row.runtime_epoch
  }))
}

/**
 * Fail a dispatch whose worker already owns the turn, with the reason a person can read. Returns
 * null when the row is no longer `ready` — a real report landing in the same instant wins, because
 * a false failure is worse than a late one.
 */
export function failReadyWorkerDispatch(
  this: OrchestrationDb,
  params: { dispatchId: string; stage: string; reason: string }
): WorkerDispatchRow | null {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || !worker || worker.state !== 'ready') {
      this.db.exec('ROLLBACK')
      return null
    }
    const updated = this.db
      .prepare(
        `UPDATE worker_dispatches
            SET state = 'failed', stage = ?, last_error = ?, updated_at = datetime('now')
          WHERE dispatch_id = ? AND state = 'ready'`
      )
      .run(params.stage, params.reason, params.dispatchId)
    if (updated.changes !== 1) {
      this.db.exec('ROLLBACK')
      return null
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
            SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
                capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
          WHERE id = ? AND status IN ('pending', 'dispatched')`
      )
      .run(params.reason, params.dispatchId)
    // Why: the same guard failWorkerStart uses — a Task with another live Dispatch is still running.
    const taskUpdate = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', completed_at = datetime('now')
          WHERE id = ? AND NOT EXISTS (
            SELECT 1 FROM dispatch_contexts
             WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
          )`
      )
      .run(dispatch.task_id)
    if (taskUpdate.changes === 1) {
      // Why: a watchdog failure strands dependents exactly like any other; without this they wait
      // `pending` forever with no reason. Same transaction, so the block never outlives a rollback.
      reconcileTaskDependents(this, dispatch.task_id)
    }
    this.closeQuestionsForDispatch(params.dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchStallMethods = {
  listWatchedWorkerDispatches: typeof listWatchedWorkerDispatches
  failReadyWorkerDispatch: typeof failReadyWorkerDispatch
}

export function attachWorkerDispatchStall(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listWatchedWorkerDispatches,
    failReadyWorkerDispatch
  })
}
