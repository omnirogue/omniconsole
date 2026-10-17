import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskDependents } from '../tasks/task-dependency-stranding'
import type { OrchestrationWorkerStartupTiming } from '../../../../../shared/orchestration-worker-outcome-receipt'

export function markWorkerDispatchReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[],
  startupTiming?: OrchestrationWorkerStartupTiming
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    if (
      startupTiming &&
      (!Number.isFinite(startupTiming.durationMs) || startupTiming.durationMs < 0)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        'Worker startup duration must be finite and nonnegative.'
      )
    }
    const startOptions = startupTiming
      ? JSON.stringify({ ...JSON.parse(worker.start_options), startupTiming })
      : worker.start_options
    this.db
      .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'ready', stage = 'input_accepted',
             effects = COALESCE(?, effects), start_options = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(effects ? JSON.stringify(effects) : null, startOptions, dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function failWorkerStart(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  // Why (#16095): revocation exists to stop a worker acting on a dispatch that never landed. A
  // prompt whose turn start went unobserved provably landed, so its worker keeps the authority its
  // own report needs.
  // Why `startupBlocker` has its own column: `reason` is for people; a decision must not parse it.
  options: { retainCapability?: boolean; startupBlocker?: string | null } = {}
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
             capability_revoked_at = CASE WHEN ? = 1 THEN capability_revoked_at
               ELSE COALESCE(capability_revoked_at, datetime('now')) END
         WHERE id = ?`
      )
      .run(reason, options.retainCapability ? 1 : 0, dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'failed', stage = ?, last_error = ?, startup_blocker = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, options.startupBlocker ?? null, dispatchId)
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
      reconcileTaskDependents(this, dispatch.task_id)
    }
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markWorkerStartUnknown(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'start_unknown', stage = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerDispatchRow | undefined
}

export type WorkerDispatchOutcomeMethods = {
  markWorkerDispatchReady: typeof markWorkerDispatchReady
  failWorkerStart: typeof failWorkerStart
  markWorkerStartUnknown: typeof markWorkerStartUnknown
  getWorkerDispatch: typeof getWorkerDispatch
}

export function attachWorkerDispatchOutcome(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerDispatchReady,
    failWorkerStart,
    markWorkerStartUnknown,
    getWorkerDispatch
  })
}
