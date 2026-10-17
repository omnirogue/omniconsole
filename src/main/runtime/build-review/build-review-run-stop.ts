import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import { pushEvent } from './build-review-pipeline-state'
import {
  releaseWorker,
  stopLiveWorker,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'

/**
 * After a run failed or was cancelled: stop every worker that is still live, then release it —
 * except a worker stuck on a startup prompt, which keeps its terminal so the person can answer
 * it; Retry or Release workspace runs the ordinary release afterwards.
 */
export async function stopAndReleaseWorkers(
  ctx: WorkerLifecycleContext,
  pipeline: BuildReviewPipelineSnapshot,
  reason: string
): Promise<void> {
  // Why: whichever step failed, any worker that already exists keeps
  // editing files until someone stops it; do that before settling.
  const workers = new Set([pipeline.builder, pipeline.reviewer, ...(pipeline.reviewers ?? [])])
  for (const worker of workers) {
    await stopLiveWorker(ctx, pipeline, worker, reason)
    if (worker.startupBlocker && worker.terminalHandle) {
      pushEvent(pipeline, 'info', worker.role, 'Kept its terminal open so you can answer it')
      continue
    }
    await releaseWorker(ctx, pipeline, worker)
  }
}
