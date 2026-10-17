import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import type { OrcaRuntimeService } from '../omni-runtime'
import { BuildReviewRpcError } from './build-review-rpc-call'
import type { ActiveRun, WorkerLifecycleContext } from './build-review-worker-lifecycle'
import {
  clearRejectedBuildReviewWorkerStart,
  markBuildReviewWorkerStart,
  recordBuildReviewWorkerStart
} from './build-review-workspace-reservation'

// These worker-start refusals are raised by validation/placement before the
// durable Dispatch insert. The reservation helper also checks that this Run
// acquired no unrecorded Dispatch during the awaited in-process RPC call.
const PRE_ACCEPT_REFUSALS = new Set([
  'agent_unconfigured',
  'consumer_fenced',
  'invalid_argument',
  'task_not_found',
  'terminal_worktree_mismatch',
  'worktree_not_found'
])

export function buildReviewReservationWorkerHooks(
  runtime: OrcaRuntimeService,
  pipeline: BuildReviewPipelineSnapshot,
  run: ActiveRun
): Pick<WorkerLifecycleContext, 'beforeWorkerStart' | 'afterWorkerStart' | 'workerStartRejected'> {
  const identity = () => {
    if (!run.reservationKey) {
      throw new Error('Build + Review has no workspace reservation.')
    }
    return [
      runtime.getOrchestrationDb(),
      run.reservationKey,
      pipeline.id,
      runtime.getRuntimeId()
    ] as const
  }
  return {
    beforeWorkerStart: () => markBuildReviewWorkerStart(...identity()),
    afterWorkerStart: (dispatchId) => recordBuildReviewWorkerStart(...identity(), dispatchId),
    workerStartRejected: (error) => {
      if (
        error instanceof BuildReviewRpcError &&
        error.code !== 'operation_unknown' &&
        error.code !== 'runtime_timeout' &&
        (PRE_ACCEPT_REFUSALS.has(error.code) ||
          (typeof error.data === 'object' &&
            error.data !== null &&
            'effectsApplied' in error.data &&
            error.data.effectsApplied === false))
      ) {
        clearRejectedBuildReviewWorkerStart(...identity())
      }
    }
  }
}
