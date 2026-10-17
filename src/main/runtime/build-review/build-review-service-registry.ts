import type { OrcaRuntimeService } from '../omni-runtime'
import { defaultBuildReviewPipelineDirectory } from './build-review-pipeline-store'
import { BuildReviewService } from './build-review-service'

const servicesByRuntime = new WeakMap<OrcaRuntimeService, BuildReviewService>()

/** One Build + Review service per runtime, its runs kept on disk. */
export function getBuildReviewService(runtime: OrcaRuntimeService): BuildReviewService {
  const existing = servicesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  // Why on disk: after a restart a run must come back as it ended, not as one nobody knows.
  const service = new BuildReviewService(runtime, undefined, undefined, {
    directory: defaultBuildReviewPipelineDirectory()
  })
  servicesByRuntime.set(runtime, service)
  return service
}
