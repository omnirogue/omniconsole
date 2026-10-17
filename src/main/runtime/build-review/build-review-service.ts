import { answerPipelineQuestion } from './build-review-questions'
import type {
  BuildReviewChangedPayload,
  BuildReviewPipelineSnapshot,
  BuildReviewStartRequest
} from '../../../shared/build-review-pipeline'
import { isBuildReviewActive } from '../../../shared/build-review-pipeline'
import { buildReviewPipelineNotFound } from '../../../shared/session-workflow-anchor'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { BuildReviewNoteReporter } from '../../../shared/build-review-note'
import { executeReviewRounds } from './build-review-rounds'
import {
  assertPipelineSeats,
  cloneSnapshot,
  createPipelineSnapshot,
  pushEvent,
  dispatchedWorkerForRead,
  resetPipelineForRetry,
  setStage,
  validatedObjective
} from './build-review-pipeline-state'
import { stopAndReleaseWorkers } from './build-review-run-stop'
import { closeCoordinator, openCoordinator } from './build-review-coordinator'
import { BuildReviewPipelineStore } from './build-review-pipeline-store'
import { BuildReviewWorkspaceKeeper } from './build-review-workspace-keeper'
import { buildReviewReservationWorkerHooks } from './build-review-reservation-worker-hooks'
import { buildReviewStartupAnswerWait } from './build-review-startup-wait'
import { createOrchestrationCaller, type OrchestrationCaller } from './build-review-rpc-call'
import {
  persistBuildReviewPlacement,
  placeBuildReviewPipeline,
  type WorkflowFleetPlacementDeps
} from './build-review-placement'
import {
  CancelledError,
  pipelineHost,
  settleDelivery,
  type ActiveRun,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'

const MAX_SETTLED_PIPELINES = 50

/** Shown when Retry finds the workspace still held after releasing what it safely can. */
const WORKSPACE_STILL_HELD =
  'This workspace is still reserved. Close the terminal it names, then choose Retry again.'

export class BuildReviewService {
  private readonly pipelines = new Map<string, BuildReviewPipelineSnapshot>()
  private readonly active = new Map<string, ActiveRun>()
  /** Runs whose Retry is releasing the workspace; they count as going until they launch. */
  private readonly retrying = new Set<string>()
  private readonly call: OrchestrationCaller
  private readonly store: BuildReviewPipelineStore | null
  private readonly workspace: BuildReviewWorkspaceKeeper

  private readonly reportReview: BuildReviewNoteReporter
  private readonly placement: WorkflowFleetPlacementDeps

  constructor(
    private readonly runtime: OrcaRuntimeService,
    call?: OrchestrationCaller,
    reportReview?: BuildReviewNoteReporter,
    /**
     * `directory`: where runs are kept across restarts; none (memory only) unless the host names
     * one. `placement`: the fleet reading's hosts file, runner and clock; tests replace them.
     */
    options: { directory?: string | null; placement?: WorkflowFleetPlacementDeps } = {}
  ) {
    this.call = call ?? createOrchestrationCaller(runtime)
    this.placement = options.placement ?? {}
    // Why injected: the omnios poster lives behind Electron; the runtime import graph must stay plain Node.
    this.reportReview = reportReview ?? ((input) => buildReviewNoteReporter(input))
    // Why opt-in: every test process installs a fake app environment, so a default directory
    // would make each service in a file load the runs the tests before it left behind.
    this.store = options.directory ? new BuildReviewPipelineStore(options.directory) : null
    for (const pipeline of this.store?.load() ?? []) {
      this.pipelines.set(pipeline.id, pipeline)
    }
    if (this.store && hasAppEnvironment()) {
      getAppEnvironment().onWillQuit(() => this.store?.flush())
    }
    this.workspace = new BuildReviewWorkspaceKeeper({
      runtime,
      call: this.call,
      pipelines: this.pipelines,
      // Why not isGoing: a Retry releases its own run's hold, which must not read as live.
      isActive: (id) => this.active.has(id),
      changed: (pipeline) => this.changed(pipeline)
    })
  }

  list(): BuildReviewPipelineSnapshot[] {
    return [...this.pipelines.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(cloneSnapshot)
  }

  show(id: string): BuildReviewPipelineSnapshot {
    return cloneSnapshot(this.workspace.refreshRestored(this.require(id)))
  }

  start(request: BuildReviewStartRequest): BuildReviewPipelineSnapshot {
    const objective = validatedObjective(request)
    // Why: both workers edit and review the live working tree, so two
    // pipelines on one workspace would review each other's half-done edits.
    const clash = this.activePipelineFor(request.worktree)
    if (clash) {
      throw new Error(`Pipeline ${clash.id} is still ${clash.stage} in this workspace.`)
    }
    const pipeline = createPipelineSnapshot({ ...request, objective })
    this.pipelines.set(pipeline.id, pipeline)
    this.evictSettled()
    pushEvent(pipeline, 'info', 'pipeline', `Pipeline created for ${request.worktree}`)
    this.launch(pipeline)
    return cloneSnapshot(pipeline)
  }

  /** Start a failed or cancelled run again with the same request, under the same id. */
  async retry(id: string): Promise<BuildReviewPipelineSnapshot> {
    const pipeline = this.require(id)
    if (this.isGoing(id) || isBuildReviewActive(pipeline.stage)) {
      throw new Error('This run is still going.')
    }
    const clash = this.activePipelineFor(pipeline.worktree)
    if (clash) {
      throw new Error(`Pipeline ${clash.id} is still ${clash.stage} in this workspace.`)
    }
    assertPipelineSeats(pipeline)
    // Why before the await: a second Retry (another window, the CLI) must not pass the same
    // checks and launch a second execution on this snapshot while the release runs.
    this.retrying.add(id)
    try {
      if (pipeline.workspaceHold && !(await this.workspace.release(pipeline))) {
        throw new Error(WORKSPACE_STILL_HELD)
      }
      resetPipelineForRetry(pipeline)
      pushEvent(pipeline, 'info', 'pipeline', 'Retry requested')
      this.launch(pipeline)
    } finally {
      this.retrying.delete(id)
    }
    return cloneSnapshot(pipeline)
  }

  /**
   * Release workspace: the existing safe reconciliation for the reservation on this run's
   * workspace. Settled workers get the ordinary release; a worker still running is never stopped.
   */
  async releaseWorkspace(id: string): Promise<BuildReviewPipelineSnapshot> {
    const pipeline = this.require(id)
    if (this.isGoing(id)) {
      throw new Error('This run is still going; cancel it before releasing its workspace.')
    }
    await this.workspace.release(pipeline)
    return cloneSnapshot(pipeline)
  }

  async cancel(id: string): Promise<BuildReviewPipelineSnapshot> {
    const pipeline = this.require(id)
    const run = this.active.get(id)
    if (!run || !isBuildReviewActive(pipeline.stage)) {
      return cloneSnapshot(pipeline)
    }
    pushEvent(pipeline, 'info', 'pipeline', 'Cancel requested by the operator')
    run.abort.abort()
    // Why: the execution owns every worker and the coordinator terminal; it
    // performs the stop/close sequence itself so cancel cannot race a start
    // that is still in flight.
    await run.execution
    return cloneSnapshot(pipeline)
  }

  async reply(id: string, messageId: string, body: string): Promise<BuildReviewPipelineSnapshot> {
    const pipeline = this.require(id)
    if (!pipeline.coordinatorTerminalHandle) {
      throw new Error('The pipeline has no coordinator terminal to reply from.')
    }
    await this.call('orchestration.reply', {
      id: messageId,
      body,
      from: pipeline.coordinatorTerminalHandle
    })
    answerPipelineQuestion(pipeline, messageId)
    pushEvent(pipeline, 'reply', 'pipeline', body)
    this.changed(pipeline)
    return cloneSnapshot(pipeline)
  }

  async readWorker(
    id: string,
    role: 'builder' | 'reviewer',
    options: { cursor?: string | number; limit?: number; reviewer?: number }
  ): Promise<unknown> {
    const worker = dispatchedWorkerForRead(this.require(id), role, options.reviewer)
    return this.call('orchestration.workerRead', {
      dispatch: worker.dispatchId,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    })
  }

  private isGoing(id: string): boolean {
    return this.active.has(id) || this.retrying.has(id)
  }

  private activePipelineFor(worktree: string): BuildReviewPipelineSnapshot | undefined {
    for (const id of [...this.active.keys(), ...this.retrying]) {
      const candidate = this.pipelines.get(id)
      if (candidate && (candidate.worktree === worktree || candidate.worktreeId === worktree)) {
        return candidate
      }
    }
    return undefined
  }

  private evictSettled(): void {
    const settled = [...this.pipelines.values()]
      .filter((pipeline) => !this.isGoing(pipeline.id))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    while (settled.length > MAX_SETTLED_PIPELINES) {
      const oldest = settled.shift()
      if (oldest) {
        this.pipelines.delete(oldest.id)
        this.store?.remove(oldest.id)
      }
    }
  }

  private lifecycle(pipeline: BuildReviewPipelineSnapshot, run: ActiveRun): WorkerLifecycleContext {
    return {
      call: this.call,
      changed: (pipeline) => this.changed(pipeline),
      ...buildReviewReservationWorkerHooks(this.runtime, pipeline, run),
      awaitStartupAnswer: buildReviewStartupAnswerWait(this.call),
      reportReview: (input) => this.reportReview(input)
    }
  }

  private require(id: string): BuildReviewPipelineSnapshot {
    const pipeline = this.pipelines.get(id)
    if (!pipeline) {
      throw new Error(buildReviewPipelineNotFound(id))
    }
    return pipeline
  }

  private changed(pipeline: BuildReviewPipelineSnapshot): void {
    this.store?.save(pipeline)
    const payload: BuildReviewChangedPayload = { pipelineId: pipeline.id, stage: pipeline.stage }
    this.runtime.notifyBuildReviewChanged(payload)
  }

  private launch(pipeline: BuildReviewPipelineSnapshot): void {
    const run: ActiveRun = {
      abort: new AbortController(),
      pendingAck: null,
      seenMessageIds: new Set(),
      execution: null
    }
    this.active.set(pipeline.id, run)
    this.changed(pipeline)
    run.execution = this.execute(pipeline, run)
  }

  private async execute(pipeline: BuildReviewPipelineSnapshot, run: ActiveRun): Promise<void> {
    const ctx = this.lifecycle(pipeline, run)
    try {
      // A refused fleet run fails here, before the coordinator and every worker.
      await placeBuildReviewPipeline(pipeline, this.placement)
      this.changed(pipeline)
      // Why persist, not flush: `changed` only queues a debounced, best-effort save; the decision
      // must be on disk before anything acts on it, and a write that fails must stop the run.
      persistBuildReviewPlacement(this.store, pipeline)
      await openCoordinator(
        {
          runtime: this.runtime,
          call: this.call,
          claimOptions: this.workspace.claimOptions(pipeline.id)
        },
        pipeline,
        run,
        (worktreeId) => this.activePipelineFor(worktreeId)
      )
      // Holding the workspace now, this run makes every earlier run's hold on it stale.
      this.workspace.record(pipeline, null)
      this.changed(pipeline)
      await executeReviewRounds(ctx, pipeline, run, (title, spec) =>
        this.createTask(pipeline, title, spec)
      )
      pushEvent(pipeline, 'info', 'pipeline', `Pipeline ${pipeline.stage}`)
    } catch (error) {
      const cancelled = error instanceof CancelledError || run.abort.signal.aborted
      const reason = cancelled ? 'cancelled' : describeError(error)
      this.workspace.recordRefusal(pipeline, error)
      await stopAndReleaseWorkers(ctx, pipeline, reason)
      await settleDelivery(ctx, pipelineHost(ctx, pipeline), run).catch(() => undefined)
      if (cancelled) {
        setStage(pipeline, 'cancelled')
        pushEvent(pipeline, 'info', 'pipeline', 'Pipeline cancelled')
      } else {
        pipeline.error = reason
        setStage(pipeline, 'failed')
        pushEvent(pipeline, 'error', 'pipeline', reason)
      }
    } finally {
      const coordinatorClosed = await closeCoordinator(this.runtime, pipeline)
      await this.workspace.settle(pipeline, run.reservationKey, coordinatorClosed)
      this.active.delete(pipeline.id)
      this.changed(pipeline)
    }
  }

  private async createTask(
    pipeline: BuildReviewPipelineSnapshot,
    title: string,
    spec: string
  ): Promise<string> {
    if (pipeline.hubTaskId) {
      if (!pipeline.projectionTaskId) {
        throw new Error('The bound Run has no execution projection Task.')
      }
      return pipeline.projectionTaskId
    }
    const created = await this.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec,
      taskTitle: title,
      run: pipeline.runId ?? undefined,
      callerTerminalHandle: pipeline.coordinatorTerminalHandle ?? undefined
    })
    return created.task.id
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let buildReviewNoteReporter: BuildReviewNoteReporter = async () => ({
  ok: false,
  message: 'Review notes are not available in this runtime.'
})

/** The desktop main process registers the omnios poster; headless runtimes keep the no-op. */
export function setBuildReviewNoteReporter(reporter: BuildReviewNoteReporter): void {
  buildReviewNoteReporter = reporter
}
