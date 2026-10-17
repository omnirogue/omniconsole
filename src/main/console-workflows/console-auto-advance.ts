import {
  CONSOLE_AUTO_ADVANCE_POLL_MS,
  CONSOLE_AUTO_ADVANCE_WINDOW_MS,
  isConsoleAutoAdvanceWorkflowId,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceStatus,
  type ConsoleAutoAdvanceStopReason
} from '../../shared/console-auto-advance'
import type { ConsoleLocalExecutionView } from '../../shared/console-local-execution'
import type {
  ConsoleWorkflowProgress,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import { decideConsoleAutoAdvance } from './console-auto-advance-decision'

export type ConsoleAutoAdvancePorts = {
  /** The existing workflow projection read; no new transport is introduced here. */
  readWorkflow(workflowId: string): Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>>
  /** The exact named activation the person's click uses. */
  start(request: {
    jobId: string
    workflowId: string
    approvedDigest: string
    worktree: string
  }): Promise<ConsoleWorkflowResult<ConsoleLocalExecutionView>>
  preference(workflowId: string): ConsoleAutoAdvancePreference
  record(workflowId: string, status: ConsoleAutoAdvanceStatus): void
  sanitize(text: string): string
  now?(): number
  warn?(message: string): void
}

type Run = { timer: ReturnType<typeof setTimeout> | null; deadline: number; activated: Set<string> }

export class ConsoleAutoAdvance {
  private readonly runs = new Map<string, Run>()
  private readonly cycles = new Map<
    string,
    { epoch: number; promise: Promise<ConsoleAutoAdvanceStatus> }
  >()
  private readonly epochs = new Map<string, number>()
  private disposed = false

  constructor(private readonly ports: ConsoleAutoAdvancePorts) {}

  /** Called after a local job's result is published; extends the bounded window and polls. */
  begin(workflowId: string): void {
    if (this.disposed || !isConsoleAutoAdvanceWorkflowId(workflowId)) {
      return
    }
    if (!this.ports.preference(workflowId).enabled) {
      return
    }
    const run = this.runs.get(workflowId) ?? { timer: null, deadline: 0, activated: new Set() }
    run.deadline = this.now() + CONSOLE_AUTO_ADVANCE_WINDOW_MS
    this.runs.set(workflowId, run)
    this.schedule(workflowId, 0)
  }

  /** Turning the preference off stops further activations immediately. */
  stop(workflowId: string, reason: ConsoleAutoAdvanceStopReason = 'turned_off'): void {
    this.epochs.set(workflowId, (this.epochs.get(workflowId) ?? 0) + 1)
    const run = this.runs.get(workflowId)
    if (!run) {
      return
    }
    if (run.timer) {
      clearTimeout(run.timer)
    }
    this.runs.delete(workflowId)
    if (reason !== 'turned_off') {
      this.ports.record(workflowId, this.status('stopped', reason, null, null))
    }
  }

  isRunning(workflowId: string): boolean {
    return this.runs.has(workflowId)
  }

  dispose(): void {
    this.disposed = true
    for (const workflowId of Array.from(this.runs.keys())) {
      this.stop(workflowId)
    }
  }

  /** One decision cycle: at most one activation, never a job outside this workflow. */
  cycle(workflowId: string): Promise<ConsoleAutoAdvanceStatus> {
    const pending = this.cycles.get(workflowId)
    const epoch = this.epochs.get(workflowId) ?? 0
    if (pending?.epoch === epoch) {
      return pending.promise
    }
    const running = this.runCycle(workflowId).finally(() => {
      if (this.cycles.get(workflowId)?.promise === running) {
        this.cycles.delete(workflowId)
      }
    })
    this.cycles.set(workflowId, { epoch, promise: running })
    return running
  }

  private async runCycle(workflowId: string): Promise<ConsoleAutoAdvanceStatus> {
    const preference = this.ports.preference(workflowId)
    const run = this.runs.get(workflowId)
    const epoch = this.epochs.get(workflowId) ?? 0
    if (!preference.enabled) {
      this.stop(workflowId)
      return this.status('off', null, null, null)
    }
    const projection = await this.ports.readWorkflow(workflowId)
    const current = this.ports.preference(workflowId)
    if (
      this.disposed ||
      !current.enabled ||
      current.worktree !== preference.worktree ||
      epoch !== (this.epochs.get(workflowId) ?? 0)
    ) {
      return current.status
    }
    if (run && this.now() >= run.deadline) {
      return this.finish(workflowId, this.status('stopped', 'timed_out', null, null))
    }
    if (!projection.ok) {
      // A transient read failure is not a decision; the bounded window keeps its own deadline.
      return this.report(workflowId, this.status('waiting', null, null, projection.error.message))
    }
    if (projection.data.workflow_id !== workflowId) {
      return this.finish(workflowId, this.status('stopped', 'refused', null, null))
    }
    const decision = decideConsoleAutoAdvance({
      workflowId,
      enabled: true,
      worktree: preference.worktree,
      jobs: projection.data.jobs,
      activated: run?.activated ?? new Set()
    })
    if (decision.action === 'wait') {
      return this.report(workflowId, this.status('waiting', null, decision.jobId, null))
    }
    if (decision.action === 'stop') {
      return this.finish(workflowId, this.status('stopped', decision.reason, decision.jobId, null))
    }
    run?.activated.add(decision.jobId)
    const started = await this.ports.start({
      jobId: decision.jobId,
      workflowId,
      approvedDigest: decision.digest,
      worktree: preference.worktree
    })
    if (
      this.disposed ||
      epoch !== (this.epochs.get(workflowId) ?? 0) ||
      !this.ports.preference(workflowId).enabled
    ) {
      return this.ports.preference(workflowId).status
    }
    if (!started.ok) {
      return this.finish(
        workflowId,
        this.status('stopped', 'refused', decision.jobId, started.error.message)
      )
    }
    return this.report(workflowId, this.status('activated', null, decision.jobId, null))
  }

  private schedule(workflowId: string, delayMs: number): void {
    const run = this.runs.get(workflowId)
    if (!run || this.disposed) {
      return
    }
    if (run.timer) {
      clearTimeout(run.timer)
    }
    run.timer = setTimeout(() => {
      void this.tick(workflowId)
    }, delayMs)
    run.timer.unref?.()
  }

  private async tick(workflowId: string): Promise<void> {
    const run = this.runs.get(workflowId)
    if (!run || this.disposed) {
      return
    }
    if (this.now() >= run.deadline) {
      this.stop(workflowId, 'timed_out')
      return
    }
    const status = await this.cycle(workflowId)
    if (this.runs.get(workflowId) !== run) {
      return
    }
    if (status.state === 'waiting' || status.state === 'activated') {
      this.schedule(workflowId, CONSOLE_AUTO_ADVANCE_POLL_MS)
    }
  }

  private report(workflowId: string, status: ConsoleAutoAdvanceStatus): ConsoleAutoAdvanceStatus {
    try {
      this.ports.record(workflowId, status)
    } catch (error) {
      this.warn(error)
    }
    return status
  }

  private finish(workflowId: string, status: ConsoleAutoAdvanceStatus): ConsoleAutoAdvanceStatus {
    const reported = this.report(workflowId, status)
    const run = this.runs.get(workflowId)
    if (run?.timer) {
      clearTimeout(run.timer)
    }
    this.runs.delete(workflowId)
    return reported
  }

  private status(
    state: ConsoleAutoAdvanceStatus['state'],
    reason: ConsoleAutoAdvanceStopReason | null,
    jobId: string | null,
    detail: string | null
  ): ConsoleAutoAdvanceStatus {
    return {
      state,
      reason,
      jobId,
      detail: detail === null ? null : this.ports.sanitize(detail).slice(0, 1500),
      updatedAt: this.now()
    }
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }

  private warn(error: unknown): void {
    this.ports.warn?.(
      this.ports.sanitize(error instanceof Error ? error.message : 'auto-advance status')
    )
  }
}
