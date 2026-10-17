import { createHash } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

/** Manual Save may start a pristine card coordinator; its IDs come exclusively from live runtime ownership. */
export function sessionOutcomePlanningSource(runtime: OrcaRuntimeService, chain: SessionChain) {
  let source: ReturnType<OrcaRuntimeService['resolveSessionOutcomePlanningCoordinator']>
  try {
    source = runtime.resolveSessionOutcomePlanningCoordinator(
      chain.sourcePaneKey,
      chain.sourceWorktreeId ?? chain.worktreeId
    )
  } catch {
    return undefined
  }
  const pane = source.paneKey
  const processIncarnation = source.processIncarnation
  const db = runtime.getOrchestrationDb()
  const run = db.getCurrentRunForPane(pane)
  if (
    !run?.hub_task_id ||
    run.origin !== 'local_bound' ||
    run.console_job ||
    run.coordinator_handle !== source.handle
  ) {
    return undefined
  }
  const tasks = db.listTasks({ runId: run.id })
  if (
    tasks.length !== 1 ||
    tasks[0]!.hub_task_id !== run.hub_task_id ||
    db.getDispatchContext(tasks[0]!.id)
  ) {
    return undefined
  }
  return {
    taskId: run.hub_task_id,
    planningSource: {
      runId: run.id,
      projectionTaskId: tasks[0]!.id,
      coordinatorHandle: source.handle,
      processIncarnation
    },
    version: createHash('sha256')
      .update(JSON.stringify([run.id, tasks[0]!.id, processIncarnation]))
      .digest('hex')
  }
}
export function assertSessionOutcomePlanningSource(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): void {
  const stored = chain.outcomeSet?.continuation.planningSource
  if (!stored) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const run = db.getRun(stored.runId)
  const task = db.getTask(stored.projectionTaskId)
  const livePane = runtime.getLiveTerminalPaneKey(stored.coordinatorHandle)
  if (
    run?.origin !== 'local_bound' ||
    run.console_job ||
    run.hub_task_id !== chain.outcomeSet!.continuation.taskId ||
    task?.run_id !== run.id ||
    task.hub_task_id !== run.hub_task_id ||
    db.getDispatchContext(stored.projectionTaskId) ||
    (livePane && db.getCurrentRunForPane(livePane)?.id !== run.id)
  ) {
    throw new Error(
      'The original pristine task coordinator changed; no new workflow stage was activated.'
    )
  }
}
