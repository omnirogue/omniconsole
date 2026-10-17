import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { getConsoleJobBindingForDispatch } from '../../orchestration/console-job-binding'
import { readConsoleJobProcessHandshake } from '../../orchestration/console-job-process-handshake'

export type WorkerTerminalLeaseRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDispatchAuthority' | 'getTerminalPaneKey' | 'getTerminalProcessIncarnation'
>

export type WorkerTerminalHostScope = NonNullable<
  ReturnType<WorkerTerminalLeaseRuntime['getOrchestrationDispatchAuthority']>
>['hostScope']

export function workerTerminalLeaseIsCurrent(
  runtime: WorkerTerminalLeaseRuntime,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  return Boolean(
    authority &&
    workerTerminalIdentityIsCurrent(runtime, db, dispatchId, resource, authority.hostScope)
  )
}

/** A retained console receipt supplies host scope, never a replacement pane or process identity. */
export function workerTerminalReleaseLeaseIsCurrent(
  runtime: WorkerTerminalLeaseRuntime,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  if (workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource)) {
    return true
  }
  if (runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)) {
    return false
  }
  const dispatch = db.getDispatchContextById(dispatchId)
  const run = dispatch && db.getRun(dispatch.run_id)
  const binding = getConsoleJobBindingForDispatch(db, dispatchId)
  if (
    !run?.console_job_principal ||
    !binding ||
    !resource.host_scope ||
    db.getFederatedDispatch(dispatchId)
  ) {
    return false
  }
  try {
    const scope = JSON.parse(resource.host_scope) as WorkerTerminalHostScope
    const handshake = readConsoleJobProcessHandshake(db, {
      runId: run.id,
      dispatchId,
      principal: run.console_job_principal,
      binding
    })
    return Boolean(
      scope.kind === 'local' &&
      handshake?.physicalExit?.event.phase === 'physical_exit' &&
      handshake.gate.exitObserver === 'macos-kqueue' &&
      resource.process_incarnation === `${handshake.gate.ptyId}:${handshake.gate.incarnationId}` &&
      workerTerminalIdentityIsCurrent(runtime, db, dispatchId, resource, scope)
    )
  } catch {
    return false
  }
}

/** The host scope may come from a physical exit receipt after live launch authority retires. */
export function workerTerminalIdentityIsCurrent(
  runtime: WorkerTerminalLeaseRuntime,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  hostScope: WorkerTerminalHostScope
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    resource.host_scope === JSON.stringify(hostScope) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
