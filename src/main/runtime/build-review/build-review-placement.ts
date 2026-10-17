import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import {
  buildReviewDispatchedSeatsRefusal,
  type WorkflowPlacement
} from '../../../shared/local-workflow-placement'
import {
  placeLocalWorkflow,
  WorkflowFleetPlacementRefusal,
  type WorkflowFleetPlacementDeps
} from '../workflow-script/local-workflow-fleet-placement'
import { pushEvent } from './build-review-pipeline-state'
import type { BuildReviewPipelineStore } from './build-review-pipeline-store'

export type { WorkflowFleetPlacementDeps }

/** The event line that records where the workers run, with the reading the choice was made on. */
export function buildReviewPlacementLine(placement: WorkflowPlacement): string {
  if (!placement.host) {
    return 'Workers run on this computer (chosen explicitly)'
  }
  const reading = `${placement.host.loadPerCore.toFixed(2)} load per core, ${placement.host.cores} cores`
  return placement.mode === 'local'
    ? `Workers run on this computer, the fleet host with the most verified spare capacity (${placement.host.name}: ${reading})`
    : `Workers placed on ${placement.host.name} (${reading}, ${placement.mode})`
}

/**
 * Where this execution's workers run, decided before the coordinator opens and before any
 * worker starts: a fleet run with no verified host, or a named host that cannot take it, throws
 * the named refusal here, as the workflow graphs do. Workers edit this workspace, so a host this
 * computer does not run on is refused too. A run persisted before placement was a choice has no
 * `runsOn` and ran here.
 */
export async function placeBuildReviewPipeline(
  pipeline: BuildReviewPipelineSnapshot,
  deps: WorkflowFleetPlacementDeps
): Promise<void> {
  delete pipeline.placement
  const placement = await placeLocalWorkflow(
    pipeline.runsOn ?? 'local',
    deps,
    pipeline.runsOnHost
      ? {
          host: pipeline.runsOnHost,
          ...(pipeline.runsOnHostId ? { hostId: pipeline.runsOnHostId } : {}),
          ...(pipeline.forceHost ? { forceReason: pipeline.forceHost } : {})
        }
      : undefined
  )
  if (placement.mode === 'dispatched-seats') {
    throw new WorkflowFleetPlacementRefusal(
      buildReviewDispatchedSeatsRefusal(placement.host?.name ?? 'that host'),
      placement
    )
  }
  pipeline.placement = placement
  pushEvent(pipeline, 'info', 'pipeline', buildReviewPlacementLine(pipeline.placement))
}

/** The placement on disk before the coordinator, or a named refusal; a memory-only host keeps none. */
export function persistBuildReviewPlacement(
  store: BuildReviewPipelineStore | null,
  pipeline: BuildReviewPipelineSnapshot
): void {
  try {
    store?.persist(pipeline)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The placement could not be recorded on disk (${reason}); nothing was started.`)
  }
}
