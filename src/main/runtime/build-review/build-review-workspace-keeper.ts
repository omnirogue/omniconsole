import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkspaceHold
} from '../../../shared/build-review-pipeline'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { BuildReviewClaimOptions } from './build-review-workspace-reservation'
import { pushEvent, roleOfDispatch } from './build-review-pipeline-state'
import type { OrchestrationCaller } from './build-review-rpc-call'
import { BuildReviewWorkspaceHeldError } from './build-review-workspace-evidence'
import {
  buildReviewClaimOptions,
  buildReviewWorkspaceHold,
  heldErrorFacts,
  releaseSettledBuildReviewWorkspace,
  terminalHandleGone,
  type BuildReviewHoldFacts,
  type BuildReviewReconcileDeps
} from './build-review-workspace-reconcile'
import {
  buildReviewWorkspaceKey,
  releaseBuildReviewWorkspace
} from './build-review-workspace-reservation'

export type BuildReviewWorkspaceKeeperHost = {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  pipelines: ReadonlyMap<string, BuildReviewPipelineSnapshot>
  isActive: (pipelineId: string) => boolean
  changed: (pipeline: BuildReviewPipelineSnapshot) => void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every worker of the run, earlier rounds included, that used this terminal. */
function markTerminalClosed(pipeline: BuildReviewPipelineSnapshot, handle: string): boolean {
  const workers = [
    pipeline.builder,
    pipeline.reviewer,
    ...(pipeline.reviewers ?? []),
    ...(pipeline.rounds ?? []).flatMap((round) => [round.builder, ...round.reviewers])
  ]
  let marked = false
  for (const worker of workers) {
    if (worker.terminalHandle === handle && !worker.terminalClosed) {
      worker.terminalClosed = true
      marked = true
    }
  }
  return marked
}

/**
 * The workspace reservation seen from the runs that hold it: count gone workers out on Start and
 * on stop, record in plain terms what still holds it, and release it when a person asks.
 */
export class BuildReviewWorkspaceKeeper {
  /** Terminals a hold named, each watched once for its exit. */
  private readonly watched = new Set<string>()
  /** Runs loaded from disk with a hold: it names terminals of an app that has since exited. */
  private readonly restored: Set<string>

  constructor(private readonly host: BuildReviewWorkspaceKeeperHost) {
    this.restored = new Set(
      [...host.pipelines.values()].filter((run) => run.workspaceHold).map((run) => run.id)
    )
  }

  /** `self` is the run asking: its own execution is winding down, not holding anything. */
  deps(self?: string): BuildReviewReconcileDeps {
    const { runtime } = this.host
    return {
      db: runtime.getOrchestrationDb(),
      call: this.host.call,
      runtimeEpoch: runtime.getRuntimeId(),
      processLiveness: (incarnation, hostScope) =>
        runtime.inspectTerminalProcessIncarnationLiveness(incarnation, hostScope),
      isExecuting: (id) => id !== self && this.host.isActive(id)
    }
  }

  claimOptions(pipelineId: string): (workspaceKey: string) => Promise<BuildReviewClaimOptions> {
    return (workspaceKey) => buildReviewClaimOptions(this.deps(pipelineId), workspaceKey)
  }

  /** A claim another run refused: name that run's hold on this one. */
  recordRefusal(pipeline: BuildReviewPipelineSnapshot, error: unknown): void {
    if (error instanceof BuildReviewWorkspaceHeldError) {
      this.record(pipeline, heldErrorFacts(error, this.host.runtime.getRuntimeId()))
    }
  }

  /** Put what holds the workspace on the run (and its holder), or clear it once it is free. */
  record(pipeline: BuildReviewPipelineSnapshot, facts: BuildReviewHoldFacts | null): void {
    const holder = facts ? this.host.pipelines.get(facts.reservation.pipeline_id) : undefined
    const hold = facts ? buildReviewWorkspaceHold(facts, (id) => roleOfDispatch(holder, id)) : null
    for (const other of this.host.pipelines.values()) {
      const related =
        other === holder ||
        other.worktree === pipeline.worktree ||
        (other.worktreeId !== null && other.worktreeId === pipeline.worktreeId)
      if (other !== pipeline && related && !this.host.isActive(other.id) && other.workspaceHold) {
        other.workspaceHold = hold
        this.host.changed(other)
      }
    }
    if (holder && holder !== pipeline && !this.host.isActive(holder.id)) {
      holder.workspaceHold = hold
      this.host.changed(holder)
    }
    pipeline.workspaceHold = hold
    this.watchHold(hold)
  }

  /**
   * The first time a restored run is shown, count out what the previous app left open; the
   * answer arrives as a change. Returns the run, as shown now.
   */
  refreshRestored(pipeline: BuildReviewPipelineSnapshot): BuildReviewPipelineSnapshot {
    if (this.restored.delete(pipeline.id)) {
      void this.refresh(pipeline).catch(() => undefined)
    }
    return pipeline
  }

  /** Look again at what holds this run's workspace, releasing no worker; record what changed. */
  async refresh(pipeline: BuildReviewPipelineSnapshot): Promise<void> {
    const before = pipeline.workspaceHold
    if (!before || this.host.isActive(pipeline.id)) {
      return
    }
    const worktree = await this.host.runtime.showManagedTerminalWorkspace(pipeline.worktree)
    const facts = await releaseSettledBuildReviewWorkspace(
      this.deps(),
      buildReviewWorkspaceKey(worktree),
      'observe'
    )
    // Why: a Retry or Release that ran meanwhile already recorded a newer answer.
    if (pipeline.workspaceHold !== before || this.host.isActive(pipeline.id)) {
      return
    }
    this.record(pipeline, facts)
    if (!facts) {
      pushEvent(pipeline, 'info', 'pipeline', 'Workspace released')
    }
    this.host.changed(pipeline)
  }

  /**
   * Why watched: closing a terminal tells no run anything, so a notice kept saying it was open,
   * and Retry kept refusing, until something else happened to look again.
   */
  private watchHold(hold: BuildReviewWorkspaceHold | null): void {
    for (const { terminalHandle: handle } of hold?.items ?? []) {
      if (handle && !this.watched.has(handle)) {
        this.watched.add(handle)
        void this.watchTerminal(handle)
      }
    }
  }

  private async watchTerminal(handle: string): Promise<void> {
    try {
      const shown = await this.host.call<{ terminal?: { ptyId?: string | null } }>(
        'terminal.show',
        { terminal: handle }
      )
      const ptyId = shown?.terminal?.ptyId
      if (ptyId) {
        this.host.runtime.subscribeToPtyExit(ptyId, () => {
          void this.terminalExited(handle).catch(() => undefined)
        })
      }
    } catch {
      // Already gone or unreadable: the next reconciliation decides.
    }
  }

  private async terminalExited(handle: string): Promise<void> {
    // Why a turn first: the exit is announced before the runtime records its cause.
    await new Promise((resolve) => setImmediate(resolve))
    const runs = [...this.host.pipelines.values()]
    // Why asked again: an exit event can be a stop nobody confirmed, which is no proof.
    if (await terminalHandleGone(this.deps(), handle)) {
      for (const pipeline of runs) {
        if (markTerminalClosed(pipeline, handle)) {
          this.host.changed(pipeline)
        }
      }
    }
    // One look is enough: recording it updates every run that shows the same hold.
    const holder = runs.find((pipeline) =>
      pipeline.workspaceHold?.items.some((item) => item.terminalHandle === handle)
    )
    if (holder) {
      await this.refresh(holder)
    }
  }

  /** Release workspace: the existing safe reconciliation; true once nothing holds it. */
  async release(pipeline: BuildReviewPipelineSnapshot): Promise<boolean> {
    const worktree = await this.host.runtime.showManagedTerminalWorkspace(pipeline.worktree)
    const facts = await releaseSettledBuildReviewWorkspace(
      this.deps(),
      buildReviewWorkspaceKey(worktree),
      'release'
    )
    this.record(pipeline, facts)
    pushEvent(
      pipeline,
      facts ? 'error' : 'info',
      'pipeline',
      facts ? 'The workspace is still reserved.' : 'Workspace released'
    )
    this.host.changed(pipeline)
    return !facts
  }

  /** On stop: free the workspace, or say what still holds it once gone workers are counted out. */
  async settle(
    pipeline: BuildReviewPipelineSnapshot,
    reservationKey: string | undefined,
    coordinatorClosed: boolean
  ): Promise<void> {
    if (!reservationKey) {
      return
    }
    if (!coordinatorClosed) {
      pushEvent(
        pipeline,
        'error',
        'pipeline',
        'Coordinator closure is unverified; workspace remains reserved.'
      )
      return
    }
    const { runtime } = this.host
    try {
      const db = runtime.getOrchestrationDb()
      if (releaseBuildReviewWorkspace(db, reservationKey, pipeline.id, runtime.getRuntimeId())) {
        this.record(pipeline, null)
        return
      }
      const deps = this.deps(pipeline.id)
      const facts = await releaseSettledBuildReviewWorkspace(deps, reservationKey, 'observe')
      this.record(pipeline, facts)
      if (facts && pipeline.runId) {
        pushEvent(
          pipeline,
          'error',
          'pipeline',
          'This workspace remains reserved because a prior worker or terminal is unresolved.'
        )
      }
    } catch (error) {
      pushEvent(pipeline, 'error', 'pipeline', `Workspace reservation: ${describeError(error)}`)
    }
  }
}
