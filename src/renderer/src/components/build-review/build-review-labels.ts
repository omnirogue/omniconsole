import { translate } from '@/i18n/i18n'
import type {
  BuildReviewStage,
  BuildReviewWorkerStatus
} from '../../../../shared/build-review-pipeline'

export function buildReviewStatusLabel(status: BuildReviewStage | BuildReviewWorkerStatus): string {
  const labels = {
    starting: translate('auto.components.build-review.Status.starting', 'Starting'),
    building: translate('auto.components.build-review.Status.building', 'Building'),
    reviewing: translate('auto.components.build-review.Status.reviewing', 'Reviewing'),
    completed: translate('auto.components.build-review.Status.completed', 'Done'),
    failed: translate('auto.components.build-review.Status.failed', 'Failed'),
    cancelled: translate('auto.components.build-review.Status.cancelled', 'Cancelled'),
    pending: translate('auto.components.build-review.Status.pending', 'Pending'),
    running: translate('auto.components.build-review.Status.running', 'Running'),
    succeeded: translate('auto.components.build-review.Status.succeeded', 'Succeeded')
  }
  return labels[status]
}
