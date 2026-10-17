import type { BuildReviewChangedPayload } from '../../shared/build-review-pipeline'

export type BuildReviewApi = {
  onChanged: (callback: (payload: BuildReviewChangedPayload) => void) => () => void
}
