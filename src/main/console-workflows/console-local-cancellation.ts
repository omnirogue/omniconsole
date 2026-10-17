import type { ConsoleLocalExecutionView } from '../../shared/console-local-execution'
import type { ConsoleJobMonitorContext } from './console-job-monitor'
import { consoleJobOutputDigest } from './console-job-digests'
import {
  consoleJobProcessIdentity,
  observeConsoleJobProcess,
  waitForConsoleJobProcessExit
} from './console-job-process-observation'
import type { ConsoleLocalResult } from './console-local-execution-contract'
import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'

export async function cancelConsoleLocalExecution(
  ctx: Pick<ConsoleJobMonitorContext, 'runtime' | 'call' | 'port' | 'results'>,
  record: ConsoleLocalExecutionRecord
): Promise<ConsoleLocalExecutionView> {
  if (ctx.results.read(record.worker.dispatch_id)) {
    throw new Error('This attempt already has a committed result.')
  }
  const identity = consoleJobProcessIdentity(record)
  if ((await ctx.port.principal()) !== identity.principal) {
    throw new Error('The signed-in person no longer owns this cancellation.')
  }
  let physical = await observeConsoleJobProcess(ctx.runtime, identity)
  let stopError: string | undefined
  if (physical.state !== 'unverifiable') {
    const worker = ctx.runtime.getOrchestrationDb().getWorkerDispatch(identity.dispatchId)
    // A prior ambiguous stop is observed again without repeating its process mutation.
    if (worker && !['stopped', 'stopping', 'stop_unknown'].includes(worker.state)) {
      try {
        const stopped = await ctx.call<{ state: string; lastError?: string }>(
          'orchestration.workerStop',
          { dispatch: identity.dispatchId }
        )
        stopError = stopped.lastError
      } catch (error) {
        stopError = error instanceof Error ? error.message : 'The bound stop was not acknowledged.'
      }
    }
    physical = await waitForConsoleJobProcessExit(ctx.runtime, identity)
  }
  if (physical.state !== 'exited') {
    return {
      ...record.view,
      state: 'unverifiable',
      error: ctx.port.sanitize(stopError ?? physical.reason)
    }
  }
  const result: ConsoleLocalResult = {
    status: 'cancelled',
    exit_code: null,
    output_tail: 'The execution host verified that the bound process has exited.',
    candidate_sha: null,
    branch: record.attempt.branch,
    pr_url: null,
    pr_number: null,
    changed_files: [],
    owned_paths_violations: [],
    terminal_proof: physical.proof,
    output_digest: ''
  }
  result.output_digest = consoleJobOutputDigest(result)
  ctx.results.record(record, result)
  await ctx.results.flush()
  const { error: _error, ...view } = record.view
  return { ...view, state: 'cancelled' }
}
