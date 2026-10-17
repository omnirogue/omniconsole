import type { BuildReviewNoteInput, BuildReviewNoteResult } from '../../../shared/build-review-note'
import type {
  BuildReviewEventKind,
  BuildReviewPipelineSnapshot
} from '../../../shared/build-review-pipeline'
import type { OrchestrationCheckOutput } from '../../../shared/orchestration-check-output'
import { describeAgentChoice } from './build-review-briefs'
import {
  workerEffortParityEventText,
  workerStartEffortParity,
  type WorkerLaunchReceiptLike
} from './build-review-worker-effort-parity'
import { applyDeliveryMessages } from './build-review-messages'
import { pushEvent } from './build-review-pipeline-state'
import { noteWorkerStartFailure } from './build-review-startup-blocker'
import type { OrchestrationCaller } from './build-review-rpc-call'
import type { WorkerUnitLike } from './build-review-worker-registry'

const WAIT_WINDOW_MS = 60_000
const WORKER_START_TIMEOUT_MS = 180_000
export const WORKER_CHECK_TYPES = 'worker_done,escalation,question,heartbeat,status'

export type ActiveRun = {
  abort: AbortController
  pendingAck: string | null
  seenMessageIds: Set<string>
  execution: Promise<void> | null
  reservationKey?: string
  previousDispatchId?: string
}

/**
 * Where a worker is placed. `worktree` is the orchestration worker-start placement
 * (`current`, `new-child`, or an exact existing workspace selector); `cwd` is the
 * folder inside that workspace the agent starts in, which is how parallel nodes are
 * isolated in a folder workspace where no worktree can be created.
 */
export type WorkerPlacement = {
  worktree: string
  name?: string
  cwd?: string
  /** Account profile the launch starts under; the runtime expands it at spawn time. */
  accountChoiceId?: string | null
  /** Start in this terminal: the one a failed start left open and the person answered in. */
  terminal?: string
  /** The failed Dispatch this start retries (an unbound Run; a card-bound one continues). */
  retryOf?: string
}

export const CURRENT_WORKSPACE_PLACEMENT: WorkerPlacement = { worktree: 'current' }

/**
 * The Run a worker belongs to, without assuming a Build + Review pipeline. Both the
 * pipeline and the local DAG runner supply one of these.
 */
export type WorkerHostContext = {
  coordinatorTerminalHandle: string | null
  runId: string | null
  /** Set only for card-bound Runs; unadmitted local Runs never have one. */
  projectionTaskId?: string
  /**
   * Send the execution brief with the dispatch instead of relying on the stored Task
   * spec. A DAG node's brief carries what its dependencies produced, which did not
   * exist when the Task was created. Defaults to the card-bound behaviour.
   */
  briefWithDispatch?: boolean
  log: (kind: BuildReviewEventKind, role: string, text: string) => void
  changed: () => void
}

export type WorkerLifecycleContext = {
  call: OrchestrationCaller
  changed: (pipeline: BuildReviewPipelineSnapshot) => void
  beforeWorkerStart?: () => void
  afterWorkerStart?: (dispatchId: string) => void
  workerStartRejected?: (error: unknown) => void
  /**
   * A start that stopped on a question the person can answer in its terminal: wait for them and
   * resolve true once answered, so the worker starts again there. Absent, the start fails.
   */
  awaitStartupAnswer?: (
    worker: WorkerUnitLike,
    host: WorkerHostContext,
    run: ActiveRun
  ) => Promise<boolean>
  /** Projects a review fact to the bound omnios card; absent for ad hoc pipelines. */
  reportReview?: (input: BuildReviewNoteInput) => Promise<BuildReviewNoteResult>
}

/** The Build + Review pipeline seen as one worker host. */
export function pipelineHost(
  ctx: WorkerLifecycleContext,
  pipeline: BuildReviewPipelineSnapshot
): WorkerHostContext {
  return {
    coordinatorTerminalHandle: pipeline.coordinatorTerminalHandle,
    runId: pipeline.runId,
    ...(pipeline.projectionTaskId ? { projectionTaskId: pipeline.projectionTaskId } : {}),
    log: (kind, role, text) =>
      pushEvent(pipeline, kind, role as 'builder' | 'reviewer' | 'pipeline', text),
    changed: () => ctx.changed(pipeline)
  }
}

type WorkerStartResult = {
  dispatchId: string
  state: string
  lastError?: string
  startupBlocker?: string
  /** Requested vs effective model/effort, as the worker-start receipt reports them. */
  launch?: WorkerLaunchReceiptLike | null
}
type WorkerShowResult = {
  worker: { state: string; agent_terminal_handle: string | null; last_error?: string | null }
}
type WorkerStopResult = { state?: string; lastError?: string | null }
type WorkerReleaseResult = { state?: string; reason?: string; recovery?: unknown }

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export function assertNotCancelled(run: ActiveRun): void {
  if (run.abort.signal.aborted) {
    throw new CancelledError()
  }
}

/**
 * What starts the agent: a new terminal takes the account, agent, model and effort; a reused one
 * already runs its agent with them, and worker-start refuses them beside `terminal`.
 */
function workerLaunch(worker: WorkerUnitLike, placement: WorkerPlacement): Record<string, unknown> {
  return placement.terminal
    ? { terminal: placement.terminal }
    : {
        ...(placement.accountChoiceId ? { accountChoiceId: placement.accountChoiceId } : {}),
        agent: worker.choice.agent,
        ...(worker.choice.model ? { model: worker.choice.model } : {}),
        ...(worker.choice.effort ? { effort: worker.choice.effort } : {})
      }
}

export async function startWorker(
  ctx: WorkerLifecycleContext,
  host: WorkerHostContext,
  run: ActiveRun,
  worker: WorkerUnitLike,
  executionBrief?: string,
  placement: WorkerPlacement = CURRENT_WORKSPACE_PLACEMENT,
  onDispatch?: (dispatchId: string) => void
): Promise<void> {
  assertNotCancelled(run)
  // Why: a reused terminal is the answered one, whose agent is already up (startup-wait).
  worker.status = placement.terminal ? 'running' : 'starting'
  host.log('worker_started', worker.role, `Starting ${describeAgentChoice(worker.choice)}`)
  host.changed()
  ctx.beforeWorkerStart?.()
  let started: WorkerStartResult
  try {
    started = await ctx.call<WorkerStartResult>('orchestration.workerStart', {
      task: worker.taskId,
      from: host.coordinatorTerminalHandle,
      worktree: placement.worktree,
      ...(placement.name ? { name: placement.name } : {}),
      ...(placement.cwd ? { cwd: placement.cwd } : {}),
      ...workerLaunch(worker, placement),
      ...(placement.retryOf && !host.projectionTaskId ? { retryOf: placement.retryOf } : {}),
      ...(host.projectionTaskId ? { continueFrom: run.previousDispatchId } : {}),
      ...(executionBrief && (host.briefWithDispatch ?? Boolean(host.projectionTaskId))
        ? { executionBrief }
        : {}),
      timeoutMs: WORKER_START_TIMEOUT_MS
    })
  } catch (error) {
    ctx.workerStartRejected?.(error)
    throw error
  }
  // Why: the dispatch id is recorded before any state check so a cancel or
  // failure that lands from here on can still stop and release this worker.
  worker.dispatchId = started.dispatchId
  ctx.afterWorkerStart?.(started.dispatchId)
  // What the worker was asked to run at, beside what the start receipt reported. Kept on
  // the worker (and stated once in the Run log) so a report produced at a lower effort
  // than the pipeline asked for is visible beside its verdict. It changes nothing about
  // how this worker is waited on, retried or trusted with authority.
  worker.effortParity = workerStartEffortParity(worker.choice, started.launch)
  const parityText = workerEffortParityEventText(worker.effortParity)
  if (parityText) {
    host.log('info', worker.role, parityText)
  }
  onDispatch?.(started.dispatchId)
  run.previousDispatchId = started.dispatchId
  if (started.state !== 'ready') {
    worker.status = 'failed'
    worker.error = started.lastError ?? `worker-start ended in state ${started.state}`
    await noteWorkerStartFailure(ctx.call, worker, started)
    if (worker.terminalHandle && (await ctx.awaitStartupAnswer?.(worker, host, run))) {
      const again = { ...placement, terminal: worker.terminalHandle, retryOf: started.dispatchId }
      return startWorker(ctx, host, run, worker, executionBrief, again, onDispatch)
    }
    host.changed()
    throw new Error(`${worker.role}: ${worker.error}`)
  }
  const shown = await ctx.call<WorkerShowResult>('orchestration.workerShow', {
    dispatch: started.dispatchId
  })
  worker.terminalHandle = shown.worker.agent_terminal_handle
  // The shared pump may have folded this worker's report during the show; never revive it.
  worker.status = worker.status === 'starting' ? 'running' : worker.status
  host.log('info', worker.role, `Dispatch ${started.dispatchId} is running`)
  assertNotCancelled(run)
}

/** Block on the Run mailbox until this worker reports; the Delivery stays unacknowledged. */
export async function waitForWorker(
  ctx: WorkerLifecycleContext,
  pipeline: BuildReviewPipelineSnapshot,
  run: ActiveRun,
  worker: WorkerUnitLike
): Promise<void> {
  while (worker.status === 'running' || worker.status === 'starting') {
    assertNotCancelled(run)
    const delivery = await ctx.call<OrchestrationCheckOutput>(
      'orchestration.check',
      {
        terminal: pipeline.coordinatorTerminalHandle,
        run: pipeline.runId ?? undefined,
        wait: true,
        types: WORKER_CHECK_TYPES,
        timeoutMs: WAIT_WINDOW_MS,
        ...(run.pendingAck ? { ack: run.pendingAck } : {})
      },
      { signal: run.abort.signal }
    )
    run.pendingAck = delivery.deliveryId ?? null
    // Why: a Delivery replays until acknowledged, so a batch seen after a
    // failed ack must not be folded into the snapshot twice.
    const fresh = delivery.messages.filter((message) => !run.seenMessageIds.has(message.id))
    for (const message of fresh) {
      run.seenMessageIds.add(message.id)
    }
    if (fresh.length > 0) {
      applyDeliveryMessages(pipeline, fresh)
      ctx.changed(pipeline)
      continue
    }
    if (delivery.messages.length === 0) {
      await assertWorkerAlive(ctx, pipeline, worker)
    }
  }
}

/** Acknowledge the outstanding Delivery once its workers have been released. */
export async function settleDelivery(
  ctx: WorkerLifecycleContext,
  host: WorkerHostContext,
  run: ActiveRun
): Promise<void> {
  if (!run.pendingAck) {
    return
  }
  await ctx.call('orchestration.check', {
    terminal: host.coordinatorTerminalHandle,
    run: host.runId ?? undefined,
    ack: run.pendingAck,
    peek: true
  })
  run.pendingAck = null
}

export async function assertWorkerAlive(
  ctx: WorkerLifecycleContext,
  host: WorkerHostContext | BuildReviewPipelineSnapshot,
  worker: WorkerUnitLike
): Promise<void> {
  if (!worker.dispatchId) {
    return
  }
  const shown = await ctx.call<WorkerShowResult>('orchestration.workerShow', {
    dispatch: worker.dispatchId
  })
  const state = shown.worker.state
  if (state === 'failed' || state === 'stopped' || state === 'abandoned') {
    worker.status = 'failed'
    worker.error = shown.worker.last_error ?? `worker ${state} without reporting`
    logOnHost(host, 'error', worker.role, worker.error)
    throw new Error(`${worker.role}: ${worker.error}`)
  }
}

export async function releaseWorker(
  ctx: WorkerLifecycleContext,
  host: WorkerHostContext | BuildReviewPipelineSnapshot,
  worker: WorkerUnitLike
): Promise<void> {
  if (!worker.dispatchId) {
    return
  }
  try {
    const receipt = await ctx.call<WorkerReleaseResult>('orchestration.workerRelease', {
      dispatch: worker.dispatchId
    })
    if (receipt.state && receipt.state !== 'released') {
      logOnHost(
        host,
        'info',
        worker.role,
        `release ${receipt.state}${receipt.reason ? ` (${receipt.reason})` : ''}`
      )
    }
  } catch (error) {
    logOnHost(host, 'error', worker.role, `release failed: ${describeError(error)}`)
  }
}

/** Stop a worker that is still live because the Run is cancelling or failing. */
export async function stopLiveWorker(
  ctx: WorkerLifecycleContext,
  host: WorkerHostContext | BuildReviewPipelineSnapshot,
  worker: WorkerUnitLike,
  reason: string
): Promise<void> {
  if (!worker.dispatchId || (worker.status !== 'starting' && worker.status !== 'running')) {
    return
  }
  try {
    const receipt = await ctx.call<WorkerStopResult>('orchestration.workerStop', {
      dispatch: worker.dispatchId
    })
    worker.status = 'failed'
    worker.error =
      receipt.state && receipt.state !== 'stopped'
        ? `${reason}; stop ${receipt.state}${receipt.lastError ? `: ${receipt.lastError}` : ''}`
        : reason
    logOnHost(host, 'info', worker.role, `stopped: ${worker.error}`)
  } catch (error) {
    worker.status = 'failed'
    worker.error = `${reason}; stop failed: ${describeError(error)}`
    logOnHost(host, 'error', worker.role, worker.error)
  }
}

// Why: these three run from both the pipeline's failure path (which still holds a
// snapshot) and the local runner (which holds a host); accept either shape.
function logOnHost(
  host: WorkerHostContext | BuildReviewPipelineSnapshot,
  kind: BuildReviewEventKind,
  role: string,
  text: string
): void {
  if ('log' in host) {
    host.log(kind, role, text)
    return
  }
  pushEvent(host, kind, role as 'builder' | 'reviewer' | 'pipeline', text)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
