import type { WorkerReportOutcome, WorkerReportSettlement } from '../../types'
import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration-db'
import { AGENT_PROMPT_STALLED_ERROR } from '../../../agent-prompt-submission-verification'
import { settleActiveDispatchesForTask } from './dispatch-completion'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'
import { reconcileTaskDependents } from '../tasks/task-dependency-stranding'
import { readWorkerCompletionPolicy } from '../../../../../shared/orchestration-worker-completion-policy'

export function settleWorkerReport(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }
): WorkerReportSettlement {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const settlement = this.settleWorkerReportInTransaction(params)
    this.db.exec('COMMIT')
    return settlement
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function settleWorkerReportInTransaction(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }
): WorkerReportSettlement {
  const task = this.getTask(params.taskId)
  if (!task) {
    return { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
  }
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    return {
      action: 'rejected',
      code: 'unknown_dispatch',
      reason: `Unknown dispatch ${params.dispatchId}.`
    }
  }
  if (dispatch.task_id !== params.taskId) {
    return {
      action: 'rejected',
      code: 'task_dispatch_mismatch',
      reason: `Dispatch ${params.dispatchId} belongs to task ${dispatch.task_id}, not ${params.taskId}.`
    }
  }

  if (params.outcome === 'succeeded') {
    // Why: a writable workflow worker must correct its result in the same Dispatch.
    const hasBindings = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_workflow_worker_calls'"
      )
      .get()
    if (hasBindings) {
      const bound = this.db
        .prepare(
          `SELECT c.call_id, c.state, c.dispatch_id, c.result_json, c.result_digest, c.artifact_digest,
                  e.state AS execution_state
           FROM local_workflow_worker_calls c
           JOIN dispatch_contexts d ON d.task_id = c.task_id AND d.run_id = c.run_id
           LEFT JOIN local_workflow_executions e ON e.id = c.execution_id
           WHERE d.id = ?`
        )
        .get(params.dispatchId) as
        | {
            call_id: string
            state: string
            dispatch_id: string | null
            result_json: string | null
            result_digest: string | null
            artifact_digest: string | null
            execution_state: string | null
          }
        | undefined
      if (
        bound &&
        (bound.state !== 'accepted' ||
          bound.dispatch_id !== params.dispatchId ||
          (!['running', 'pausing'].includes(bound.execution_state ?? '') &&
            !(
              bound.execution_state === 'completed' &&
              dispatch.status === 'completed' &&
              task.status === 'completed'
            )) ||
          !bound.result_json ||
          createHash('sha256').update(bound.result_json).digest('hex') !== bound.result_digest ||
          ((bound.call_id.startsWith('answers/') || bound.call_id === 'synthesis/final') &&
            !/^[a-f0-9]{64}$/.test(bound.artifact_digest ?? '')))
      ) {
        return {
          action: 'rejected',
          code: 'structured_result_required',
          reason: `Workflow Dispatch ${params.dispatchId} must submit and validate its structured result before reporting success.`
        }
      }
    }
  }

  const expectedDispatchStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  // Why (#16095): worker-start records a stalled prompt as failed, but the preamble was written
  // before verification ran — the worker may have been executing it the whole time. Its own report
  // is first-hand evidence and must be able to correct that record instead of being thrown away.
  // Checked before the duplicate short-circuit: a `failed` report lands on the very statuses that
  // short-circuit reads as already settled, dropping the worker's real cause and result body.
  const settledByUnobservedPrompt =
    dispatch.status === 'failed' &&
    dispatch.last_failure === AGENT_PROMPT_STALLED_ERROR &&
    task.status === 'failed'
  if (
    !settledByUnobservedPrompt &&
    dispatch.status === expectedDispatchStatus &&
    task.status === expectedTaskStatus
  ) {
    return { action: 'settled', outcome: params.outcome, duplicate: true }
  }
  const previous = settledByUnobservedPrompt
    ? { status: 'failed', workerState: 'failed' }
    : { status: 'dispatched', workerState: 'ready' }
  if (dispatch.status !== previous.status || task.status !== previous.status) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
    }
  }
  const conflictingWorker = this.db
    .prepare(
      `SELECT active.id
       FROM dispatch_contexts active
       JOIN worker_dispatches worker ON worker.dispatch_id = active.id
       WHERE active.task_id = ? AND active.id != ?
         AND active.status IN ('pending', 'dispatched')
         AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
       ORDER BY active.rowid DESC LIMIT 1`
    )
    .get(params.taskId, params.dispatchId) as { id: string } | undefined
  if (conflictingWorker) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Task ${params.taskId} still has active supervised Dispatch ${conflictingWorker.id}; stop or settle it before completing ${params.dispatchId}.`
    }
  }
  const reportingWorker = this.getWorkerDispatch(params.dispatchId)
  if (
    reportingWorker &&
    readWorkerCompletionPolicy(reportingWorker.start_options) &&
    this.db
      .prepare(
        `SELECT 1 FROM question_threads WHERE dispatch_id = ? AND status = 'pending' LIMIT 1`
      )
      .get(params.dispatchId)
  ) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Dispatch ${params.dispatchId} still has an unanswered question; answer it before accepting worker_done.`
    }
  }
  const latest = getActiveDispatchForTask(this, params.taskId)
  if (!reportingWorker && latest?.id !== params.dispatchId) {
    return {
      action: 'rejected',
      code: 'stale_dispatch',
      reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
    }
  }
  const siblingDispatchIds = this.db
    .prepare(
      `SELECT id FROM dispatch_contexts
       WHERE task_id = ? AND id != ? AND status IN ('pending', 'dispatched')`
    )
    .all(params.taskId, params.dispatchId) as { id: string }[]

  this.db.exec('SAVEPOINT settle_worker_report')
  const dispatchUpdate = this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET status = ?, completed_at = datetime('now'),
           last_failure = CASE WHEN ? = 'failed' THEN ? ELSE last_failure END,
           capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
       WHERE id = ? AND status = ?`
    )
    .run(
      expectedDispatchStatus,
      expectedDispatchStatus,
      params.result,
      params.dispatchId,
      previous.status
    )
  const taskUpdate = this.db
    .prepare(
      `UPDATE tasks
       SET status = ?, result = ?, completed_at = datetime('now')
       WHERE id = ? AND status = ?`
    )
    .run(expectedTaskStatus, params.result, params.taskId, previous.status)
  if (dispatchUpdate.changes !== 1 || taskUpdate.changes !== 1) {
    this.db.exec('ROLLBACK TO settle_worker_report')
    this.db.exec('RELEASE settle_worker_report')
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Dispatch ${params.dispatchId} changed while its worker report was settling.`
    }
  }
  this.db
    .prepare(
      `UPDATE worker_dispatches
       SET state = ?, stage = 'settled', updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = ?`
    )
    .run(
      params.outcome === 'succeeded' ? 'succeeded' : 'failed',
      params.dispatchId,
      previous.workerState
    )
  settleActiveDispatchesForTask(
    this,
    params.taskId,
    expectedDispatchStatus,
    params.outcome === 'failed' ? params.result : undefined
  )
  this.closeQuestionsForDispatch(params.dispatchId)
  for (const sibling of siblingDispatchIds) {
    this.closeQuestionsForDispatch(sibling.id)
  }
  // A failed report strands its dependents; a success promotes them.
  reconcileTaskDependents(this, params.taskId)
  this.db.exec('RELEASE settle_worker_report')
  return { action: 'settled', outcome: params.outcome, duplicate: false }
}

export type WorkerReportSettlementMethods = {
  settleWorkerReport: typeof settleWorkerReport
  settleWorkerReportInTransaction: typeof settleWorkerReportInTransaction
}

export function attachWorkerReportSettlement(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    settleWorkerReport,
    settleWorkerReportInTransaction
  })
}
