import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  bindConsoleJobDispatch,
  getConsoleJobBinding
} from '../runtime/orchestration/console-job-binding'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { WorkerStartInput } from '../runtime/rpc/methods/orchestration-worker-start-schema'

export function assertConsoleWorkerCorrelation(
  db: OrchestrationDb,
  runId: string,
  params: WorkerStartInput
): void {
  const binding = getConsoleJobBinding(db, runId)
  const attempt = params.consoleExecution
  if (!binding && !attempt) {
    return
  }
  if (
    !binding ||
    !attempt ||
    (binding.claim && db.getRun(runId)?.console_job_dispatch_id) ||
    attempt.job.id !== binding.jobId ||
    attempt.job.taskId !== binding.taskId ||
    attempt.job.workflowId !== binding.workflowId ||
    attempt.job.placement !== 'local' ||
    params.worktree !== `id:${attempt.worktreeId}` ||
    (attempt.job.workspace?.kind === 'folder' && params.cwd !== undefined) ||
    params.agent !== attempt.job.provider ||
    params.model !== attempt.job.model ||
    JSON.stringify(params.openrouterCandidates) !==
      JSON.stringify(attempt.job.openrouterCandidates) ||
    params.effort !== attempt.job.effort ||
    params.executionBrief === undefined ||
    params.terminal !== undefined ||
    params.on !== undefined
  ) {
    throw new OrchestrationError(
      'console_job_binding_mismatch',
      'The worker must preserve its admitted job, local worktree and execution preferences.'
    )
  }
}

export function bindConsoleWorkerDispatch(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string
): void {
  const binding = getConsoleJobBinding(db, runId)
  if (binding?.claim) {
    bindConsoleJobDispatch(db, {
      runId,
      dispatchId,
      binding,
      principal: db.getRun(runId)!.console_job_principal!
    })
  }
}
