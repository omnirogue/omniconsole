import type { ConsoleLocalExecutionView } from '../../shared/console-local-execution'
import type { ConsoleJobBinding } from '../../shared/console-workflow-types'
import { getConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { RunRow, WorkerDispatchRow } from '../runtime/orchestration/types'
import {
  consoleLocalAttemptSchema,
  type ConsoleLocalAttempt
} from './console-local-execution-schema'

export type ConsoleLocalExecutionRecord = {
  run: RunRow
  worker: WorkerDispatchRow
  binding: ConsoleJobBinding
  attempt: ConsoleLocalAttempt
  view: ConsoleLocalExecutionView
}

export function listConsoleLocalExecutions(
  db: OrchestrationDb,
  principal: string
): ConsoleLocalExecutionRecord[] {
  const records: ConsoleLocalExecutionRecord[] = []
  for (const run of db.listRuns().runs) {
    if (run.console_job_principal !== principal) {
      continue
    }
    const binding = getConsoleJobBinding(db, run.id)
    if (!binding) {
      continue
    }
    const workers = db.db
      .prepare(`SELECT w.* FROM worker_dispatches w
      JOIN dispatch_contexts d ON d.id = w.dispatch_id WHERE d.run_id = ? ORDER BY w.created_at DESC`)
      .all(run.id) as WorkerDispatchRow[]
    for (const worker of workers) {
      let attempt: ConsoleLocalAttempt
      try {
        attempt = consoleLocalAttemptSchema.parse(JSON.parse(worker.start_options).consoleExecution)
      } catch {
        continue
      }
      if (
        attempt.job.id !== binding.jobId ||
        attempt.job.taskId !== binding.taskId ||
        attempt.job.workflowId !== binding.workflowId ||
        attempt.worktreeId !== worker.worktree_id
      ) {
        continue
      }
      records.push({
        run,
        worker,
        binding,
        attempt,
        view: {
          jobId: binding.jobId,
          workflowId: binding.workflowId,
          cardId: binding.taskId,
          runId: run.id,
          dispatchId: worker.dispatch_id,
          terminalHandle: worker.agent_terminal_handle,
          worktreeId: attempt.worktreeId,
          branch: attempt.branch,
          state: readConsoleJobProcessHandshake(db, {
            runId: run.id,
            dispatchId: worker.dispatch_id,
            principal,
            binding
          })?.physicalExit
            ? 'exited'
            : worker.state === 'ready'
              ? 'running'
              : worker.state === 'starting'
                ? 'starting'
                : 'unverifiable',
          ...(worker.last_error ? { error: worker.last_error } : {})
        }
      })
    }
  }
  return records
}
