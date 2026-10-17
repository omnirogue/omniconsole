import type {
  ConsoleLocalExecutionApi,
  ConsoleLocalExecutionView,
  ConsoleLocalStartRequest
} from '../../shared/console-local-execution'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { OrchestrationWorkerReadResult } from '../../shared/orchestration-worker-output'
import {
  createOrchestrationCaller,
  type OrchestrationCaller
} from '../runtime/build-review/build-review-rpc-call'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { cancelConsoleLocalExecution } from './console-local-cancellation'
import { ConsoleJobResultGate } from './console-job-result-gate'
import { activateApprovedConsoleJob, ConsoleLocalRefusal } from './console-job-activation'
import { monitorConsoleJob, type ConsoleResultJournal } from './console-job-monitor'
import {
  consoleJobProcessIdentity,
  observeConsoleJobProcess
} from './console-job-process-observation'
import type { ConsoleLocalExecutionPort } from './console-local-execution-contract'
import { consoleLocalStartRequest } from './console-local-execution-schema'
import { registerConsoleWorkerStartPort } from './console-worker-start-gate'
import {
  listConsoleLocalExecutions,
  type ConsoleLocalExecutionRecord
} from './console-local-execution-state'

const MONITOR_RETRY_MS = 60_000

export class ConsoleLocalExecution implements ConsoleLocalExecutionApi {
  private readonly call: OrchestrationCaller
  private readonly starts = new Map<
    string,
    Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  >()
  private readonly monitors = new Map<string, AbortController>()
  private readonly errors = new Map<string, string>()
  /** When a MONITOR (not a cancel) last failed; the record is watched again after the cool-down. */
  private readonly monitorFailedAt = new Map<string, number>()
  private readonly resultGate = new ConsoleJobResultGate()
  private disposed = false
  private readonly releaseStartPort: () => void

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly port: ConsoleLocalExecutionPort,
    private readonly results: ConsoleResultJournal,
    call?: OrchestrationCaller
  ) {
    this.call = call ?? createOrchestrationCaller(runtime)
    this.releaseStartPort = registerConsoleWorkerStartPort(runtime, port)
  }

  start(
    request: ConsoleLocalStartRequest
  ): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>> {
    const parsed = consoleLocalStartRequest.safeParse(request)
    if (!parsed.success) {
      return Promise.resolve(
        this.failure('invalid_request', 'Select one ready job and approve its exact graph digest.')
      )
    }
    const pending = this.starts.get(parsed.data.jobId)
    if (pending) {
      return pending
    }
    const execution = this.attempt(() => this.startApproved(parsed.data)).finally(() =>
      this.starts.delete(parsed.data.jobId)
    )
    this.starts.set(parsed.data.jobId, execution)
    return execution
  }

  list(): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView[]>> {
    return this.attempt(async () => {
      const records = await this.records()
      const views = await Promise.all(records.map((record) => this.observedView(record)))
      for (const record of records) {
        this.resume(record)
      }
      return views
    })
  }

  cancel(request: { jobId: string }): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>> {
    return this.attempt(async () => {
      const record = await this.find(request?.jobId)
      this.monitors.get(record.worker.dispatch_id)?.abort()
      // Why: whatever the cancel answers is final; a stale monitor stamp must not let the
      // cool-down retry erase a failed cancellation's error.
      this.monitorFailedAt.delete(record.worker.dispatch_id)
      return this.resultGate.run(record.worker.dispatch_id, async () => {
        const view = await cancelConsoleLocalExecution(
          { runtime: this.runtime, call: this.call, port: this.port, results: this.results },
          record
        )
        if (view.error) {
          this.errors.set(record.worker.dispatch_id, view.error)
        } else {
          this.errors.delete(record.worker.dispatch_id)
        }
        return view
      })
    })
  }

  readWorker(request: {
    jobId: string
    cursor?: string | number
    limit?: number
  }): Promise<ConsoleWorkflowResult<OrchestrationWorkerReadResult>> {
    return this.attempt(async () => {
      const record = await this.find(request?.jobId)
      return this.call('orchestration.workerRead', {
        dispatch: record.worker.dispatch_id,
        cursor: request.cursor,
        limit: request.limit === undefined ? 100 : Math.min(request.limit, 500)
      })
    })
  }

  focus(request: { jobId: string }): Promise<ConsoleWorkflowResult<null>> {
    return this.attempt(async () => {
      const record = await this.find(request?.jobId)
      if (!record.worker.agent_terminal_handle) {
        throw new Error('The attempt has no live terminal handle.')
      }
      await this.runtime.focusTerminal(record.worker.agent_terminal_handle)
      return null
    })
  }

  dispose(): void {
    this.releaseStartPort()
    this.disposed = true
    for (const monitor of this.monitors.values()) {
      monitor.abort()
    }
    this.monitors.clear()
  }

  private async startApproved(
    request: ConsoleLocalStartRequest
  ): Promise<ConsoleLocalExecutionView> {
    if (this.disposed) {
      throw new Error('Workflow execution is shutting down.')
    }
    let activationAttempted = false
    let view: ConsoleLocalExecutionView
    try {
      view = await activateApprovedConsoleJob({
        runtime: this.runtime,
        call: this.call,
        port: this.port,
        results: this.results,
        records: () => this.records(),
        request,
        onActivationAttempt: () => {
          activationAttempted = true
        }
      })
    } catch (error) {
      throw new ConsoleLocalRefusal(
        error instanceof ConsoleLocalRefusal ? error.code : 'local_execution_refused',
        error instanceof Error ? error.message : 'The local execution could not be verified.',
        activationAttempted ? 'unverifiable' : 'not-started'
      )
    }
    const record = (await this.records()).find(
      (item) => item.worker.dispatch_id === view.dispatchId
    )
    if (record) {
      this.resume(record)
    }
    return view
  }

  private async records(): Promise<ConsoleLocalExecutionRecord[]> {
    const principal = await this.port.principal()
    if (!principal) {
      throw new ConsoleLocalRefusal(
        'signed_in_required',
        'Sign in as the person who activated these jobs.'
      )
    }
    return listConsoleLocalExecutions(this.runtime.getOrchestrationDb(), principal)
  }

  private async find(jobId: string): Promise<ConsoleLocalExecutionRecord> {
    if (typeof jobId !== 'string' || !/^job_[A-Za-z0-9_-]+$/.test(jobId)) {
      throw new Error('A valid named job is required.')
    }
    const record = (await this.records()).find((item) => item.binding.jobId === jobId)
    if (!record) {
      throw new Error('No Dispatch for this job belongs to this Mac and signed-in person.')
    }
    return record
  }

  private resume(record: ConsoleLocalExecutionRecord): void {
    const id = record.worker.dispatch_id
    if (this.disposed || this.monitors.has(id)) {
      return
    }
    if (this.errors.has(id)) {
      // Why: a lost contact or a busy host is an observation, not a verdict on the
      // Dispatch; without a retry one transient failure left the attempt
      // 'unverifiable' and unwatched until the app restarted. A cancel's error
      // (no failed-at stamp) stays final.
      const failedAt = this.monitorFailedAt.get(id)
      if (failedAt === undefined || Date.now() - failedAt < MONITOR_RETRY_MS) {
        return
      }
      this.errors.delete(id)
      this.monitorFailedAt.delete(id)
    }
    const abort = new AbortController()
    this.monitors.set(record.worker.dispatch_id, abort)
    void monitorConsoleJob(
      {
        runtime: this.runtime,
        call: this.call,
        port: this.port,
        results: this.results,
        resultGate: this.resultGate,
        cancel: (jobId) => this.cancel({ jobId })
      },
      record,
      abort.signal
    )
      .catch((error) => {
        if (!abort.signal.aborted) {
          this.monitorFailedAt.set(record.worker.dispatch_id, Date.now())
          this.errors.set(
            record.worker.dispatch_id,
            this.port.sanitize(
              error instanceof Error ? error.message : 'The local execution is unverifiable.'
            )
          )
        }
      })
      .finally(() => this.monitors.delete(record.worker.dispatch_id))
  }

  private view(record: ConsoleLocalExecutionRecord): ConsoleLocalExecutionView {
    const result = this.results.read(record.worker.dispatch_id)
    const error = this.errors.get(record.worker.dispatch_id)
    return {
      ...record.view,
      ...(result ? { state: result.status === 'done' ? 'exited' : result.status } : {}),
      ...(error ? { state: 'unverifiable', error } : {})
    }
  }

  private async observedView(
    record: ConsoleLocalExecutionRecord
  ): Promise<ConsoleLocalExecutionView> {
    const view = this.view(record)
    if (view.state !== 'running') {
      return view
    }
    // A persisted ready worker cannot restore the native process observer after app restart.
    const observed = await observeConsoleJobProcess(
      this.runtime,
      consoleJobProcessIdentity(record)
    ).catch((error) => ({
      state: 'unverifiable' as const,
      reason: error instanceof Error ? error.message : 'The local execution is unverifiable.'
    }))
    const current = this.view(record)
    if (current.state !== 'running' || observed.state === 'live') {
      return current
    }
    return observed.state === 'exited'
      ? { ...current, state: 'exited' }
      : { ...current, state: 'unverifiable', error: this.port.sanitize(observed.reason) }
  }

  private async attempt<T>(work: () => Promise<T>): Promise<ConsoleWorkflowResult<T>> {
    try {
      return { ok: true, data: JSON.parse(this.port.sanitize(JSON.stringify(await work()))) as T }
    } catch (error) {
      return this.failure(
        error instanceof ConsoleLocalRefusal ? error.code : 'local_execution_refused',
        error instanceof Error ? error.message : 'The local execution could not be verified.',
        error instanceof ConsoleLocalRefusal ? error.launchDisposition : undefined
      )
    }
  }

  private failure<T>(
    code: string,
    message: string,
    launchDisposition?: 'not-started' | 'unverifiable'
  ): ConsoleWorkflowResult<T> {
    const safeCode = this.port.sanitize(code)
    return {
      ok: false,
      error: {
        code: /^[a-zA-Z0-9_-]{1,96}$/.test(safeCode) ? safeCode : 'local_execution_refused',
        message: this.port.sanitize(message).slice(0, 1500),
        ...(launchDisposition ? { launchDisposition } : {})
      }
    }
  }
}
