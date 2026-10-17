import type { WorkerUnitLike } from './build-review-worker-registry'
import {
  assertNotCancelled,
  CURRENT_WORKSPACE_PLACEMENT,
  releaseWorker,
  settleDelivery,
  startWorker,
  type ActiveRun,
  type WorkerHostContext,
  type WorkerLifecycleContext,
  type WorkerPlacement
} from './build-review-worker-lifecycle'

export type RunWorkerUnitArgs = {
  ctx: WorkerLifecycleContext
  host: WorkerHostContext
  run: ActiveRun
  worker: WorkerUnitLike
  title: string
  spec: string
  /** Creates (or reuses) the Task this worker executes. */
  createTask: (title: string, spec: string) => Promise<string>
  /** Blocks until this worker reports. One mailbox pump per Run owns this. */
  waitForReport: (worker: WorkerUnitLike) => Promise<void>
  placement?: WorkerPlacement
  /** Called with the dispatch id the moment worker-start returned it. */
  onDispatch?: (dispatchId: string) => void
  /**
   * Serializes the create-and-start phase across a parallel batch. Two workers may
   * wait at once — that is the point of the pump — but two simultaneous
   * worker-starts would race for the same coordinator terminal and Run generation.
   */
  startGate?: (start: () => Promise<void>) => Promise<void>
  /**
   * Acknowledge the outstanding Delivery when this worker is released. A Run has one
   * Delivery, so a batch of parallel workers settles it once, not once per worker.
   */
  settle?: boolean
}

/**
 * One worker from Task to settled Delivery: createTask, startWorker, wait, release
 * and (for a single-worker batch) settleDelivery. Build + Review runs one of these
 * at a time; the local DAG runner runs several against one mailbox pump.
 */
export async function runWorkerUnit(args: RunWorkerUnitArgs): Promise<void> {
  const { ctx, host, run, worker } = args
  assertNotCancelled(run)
  const begin = async (): Promise<void> => {
    worker.taskId = await args.createTask(args.title, args.spec)
    await startWorker(
      ctx,
      host,
      run,
      worker,
      args.spec,
      args.placement ?? CURRENT_WORKSPACE_PLACEMENT,
      args.onDispatch
    )
  }
  await (args.startGate ? args.startGate(begin) : begin())
  try {
    await args.waitForReport(worker)
  } finally {
    // Why: whatever the report said, the worker keeps its terminal and its
    // workspace until it is released; a thrown wait must not leak either.
    await releaseWorker(ctx, host, worker)
  }
  if (args.settle !== false) {
    await settleDelivery(ctx, host, run)
  }
  assertNotCancelled(run)
}
