import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { isEquivalentPaneKey } from './orchestration/db/pane-key-match'

/** Local worker admission persists a Dispatch before process birth; missing remote contact proves nothing. */
export function sessionOutcomeLaunchNotStarted(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt
): boolean {
  // Every execution path durably leaves prepared before it can request a worker.
  if (attempt.state === 'prepared') {
    return Boolean(
      !attempt.dispatchId &&
      !attempt.taskId &&
      !attempt.continuationTaskId &&
      !attempt.nativeContinuation
    )
  }
  if (
    attempt.dispatchId ||
    !attempt.runId ||
    !['launching', 'unverifiable'].includes(attempt.state)
  ) {
    return false
  }
  const db = runtime.getOrchestrationDb()
  const run = db.getRun(attempt.runId)
  if (!run || run.console_job) {
    return false
  }
  if (!attempt.taskId) {
    return Boolean(
      !run.hub_task_id &&
      attempt.coordinatorHandle &&
      run.coordinator_handle === attempt.coordinatorHandle &&
      (!attempt.coordinatorPaneKey ||
        (run.coordinator_pane_key &&
          isEquivalentPaneKey(run.coordinator_pane_key, attempt.coordinatorPaneKey))) &&
      db.listTasks({ runId: attempt.runId }).length === 0
    )
  }
  const task = db.getTask(attempt.taskId)
  if (!task || task.run_id !== attempt.runId) {
    return false
  }
  const latest = db.getDispatchContext(attempt.taskId)
  const native = attempt.nativeContinuation
  if (!native) {
    return !attempt.continuationTaskId && !run.hub_task_id && !task.hub_task_id && !latest
  }
  const previous = db.getDispatchContextById(native.previousDispatchId)
  const worker = db.getWorkerDispatch(native.previousDispatchId)
  return Boolean(
    run.origin === 'local_bound' &&
    run.hub_task_id === attempt.continuationTaskId &&
    task.hub_task_id === attempt.continuationTaskId &&
    latest?.id === native.previousDispatchId &&
    previous?.task_id === task.id &&
    previous.run_id === run.id &&
    ['completed', 'failed'].includes(previous.status) &&
    ['completed', 'failed'].includes(task.status) &&
    worker &&
    ['succeeded', 'failed'].includes(worker.state)
  )
}
