import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import { applyDeliveryToTarget } from './build-review-messages'
import { BuildReviewWorkerRegistry } from './build-review-questions'
import {
  assertNotCancelled,
  pipelineHost,
  releaseWorker,
  settleDelivery,
  stopLiveWorker,
  type ActiveRun,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'
import { RunMailboxPump } from './local-run-mailbox-pump'
import { runWorkerUnit } from './build-review-worker-unit'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every reviewer of a round at once, the local runner's way: starts stay serialized behind one
 * gate, and all waits share the Run's single mailbox pump (`check --wait` is exclusive). The first
 * reviewer that fails ends the batch: a unanimous round cannot pass without it, so live siblings
 * are stopped and unstarted ones never start. Resolves once every reviewer settled.
 */
export async function runReviewersInParallel(args: {
  ctx: WorkerLifecycleContext
  pipeline: BuildReviewPipelineSnapshot
  run: ActiveRun
  reviewers: readonly BuildReviewWorkerSnapshot[]
  round: number
  /** Each reviewer's own brief: its rubric and its findings from the previous round differ. */
  specFor: (index: number) => string
  createTask: (title: string, spec: string) => Promise<string>
}): Promise<void> {
  const { ctx, pipeline, run } = args
  const host = pipelineHost(ctx, pipeline)
  const registry = new BuildReviewWorkerRegistry(pipeline)
  const pump = new RunMailboxPump(ctx, host, run, registry)
  let failure: { error: unknown } | null = null
  let startChain: Promise<void> = Promise.resolve()
  const startGate = (start: () => Promise<void>): Promise<void> => {
    const queued = startChain.then(() => {
      if (failure) {
        throw new Error('Not started: another reviewer of this round already failed.')
      }
      return start()
    })
    startChain = queued.catch(() => undefined)
    return queued
  }
  const fail = async (reviewer: BuildReviewWorkerSnapshot, index: number, error: unknown) => {
    failure ??= { error }
    reviewer.error ??= describe(error)
    await stopLiveWorker(ctx, host, reviewer, reviewer.error)
    await releaseWorker(ctx, host, reviewer)
    for (const sibling of args.reviewers) {
      await stopLiveWorker(ctx, host, sibling, `Stopped: reviewer ${index + 1} failed`)
    }
    // The stopped siblings' waits settle now instead of holding the round open.
    registry.notify()
    pump.wake()
  }
  await Promise.allSettled(
    args.reviewers.map((reviewer, index) =>
      runWorkerUnit({
        ctx,
        host,
        run,
        worker: reviewer,
        title: `Review ${index + 1} · round ${args.round}`,
        spec: args.specFor(index),
        createTask: args.createTask,
        waitForReport: (unit) => registry.waitFor(unit),
        onDispatch: (dispatchId) => {
          const early = registry.bind(reviewer, dispatchId)
          if (early.length > 0) {
            applyDeliveryToTarget(registry.asMailboxTarget(host.log), early)
            registry.notify()
          }
          pump.ensure()
          host.changed()
        },
        startGate,
        settle: false
      }).catch((error: unknown) =>
        run.abort.signal.aborted ? undefined : fail(reviewer, index, error)
      )
    )
  )
  pump.wake()
  await pump.stop()
  await settleDelivery(ctx, host, run).catch(() => undefined)
  assertNotCancelled(run)
  if (failure) {
    throw (failure as { error: unknown }).error
  }
}
