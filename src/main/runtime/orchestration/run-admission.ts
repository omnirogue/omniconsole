import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import { resolveOrchestrationCaller } from '../rpc/methods/orchestration-run-scope'
import { createHubTaskProjection } from './db/tasks/task-store'
import type { ConsoleJobActivationReceipt } from './console-job-activation-receipt'
import type { RunRow } from './types'

/**
 * Admission evidence for a console job. It is reachable only from the main
 * process console launch path (`console-job-admission.ts`), which builds it
 * from the BFF's own activation response after re-checking the signed-in
 * person. No RPC method or CLI command can construct or forward it, which is
 * what keeps `origin = 'hub_dispatched'` out of a caller's hands.
 */
export type ConsoleJobRunAdmission = {
  binding: ConsoleJobBinding
  principal: string
  activation: ConsoleJobActivationReceipt
}

export type AdmittedRun = {
  run: RunRow
  binding: { consumerGeneration: number }
  projectionTaskId?: string
}

/**
 * The single place a Run is created for a coordinator terminal. The public
 * `orchestration.runCreate` RPC calls this without `consoleJob`; the console
 * launch path calls it directly with the admission it just received from the
 * server. Both share the pane resolution, card projection and observation
 * bookkeeping so the two admissions cannot drift apart.
 */
export function admitOrchestrationRun(args: {
  runtime: OrcaRuntimeService
  objective: string
  callerTerminalHandle: string
  callerEvidence?: OrchestrationCompatibilityEvidence
  hubTaskId?: string
  hubStateRevision?: number
  consoleJob?: ConsoleJobRunAdmission
}): AdmittedRun {
  const { runtime } = args
  const paneKey = resolveOrchestrationCaller(runtime, {
    callerTerminalHandle: args.callerTerminalHandle,
    callerEvidence: args.callerEvidence,
    requireStablePane: true
  })
  const db = runtime.getOrchestrationDb()
  const priorRun = db.getCurrentRunForPane(paneKey)
  let run: RunRow
  let projectionTaskId: string | undefined
  db.db.exec('SAVEPOINT admit_executor_run')
  try {
    run = db.createRun({
      objective: args.objective,
      coordinatorHandle: args.callerTerminalHandle,
      coordinatorPaneKey: paneKey,
      coordinatorProcessIncarnation:
        runtime.getTerminalProcessIncarnation(args.callerTerminalHandle) ?? undefined,
      hubTaskId: args.hubTaskId,
      hubStateRevision: args.hubStateRevision,
      consoleJob: args.consoleJob?.binding,
      consoleJobPrincipal: args.consoleJob?.principal,
      consoleJobActivation: args.consoleJob?.activation
    })
    if (run.hub_task_id) {
      // The CLI knows only the existing card identity. The worker must read
      // get_task/resume; its local objective is not canonical business data.
      projectionTaskId = createHubTaskProjection(db, {
        runId: run.id,
        hubTaskId: run.hub_task_id
      }).id
    }
    db.db.exec('RELEASE admit_executor_run')
  } catch (error) {
    db.db.exec('ROLLBACK TO admit_executor_run')
    db.db.exec('RELEASE admit_executor_run')
    throw error
  }
  runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
  runtime.cancelMessageWaiters(args.callerTerminalHandle)
  if (priorRun) {
    runtime.cancelMessageWaiters(`run:${priorRun.id}`)
  }
  return {
    run,
    binding: { consumerGeneration: run.consumer_generation },
    ...(projectionTaskId ? { projectionTaskId } : {})
  }
}
