import type {
  ArtifactLifecycleSnapshot,
  ArtifactReviewState
} from '../../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'

export type ArtifactReviewPill = { label: string; className: string }

const CLOSED_PILL_CLASS = 'border-border bg-muted text-muted-foreground'

/**
 * The review pill for an artifact that asks for one; null for a plain (non-review) artifact.
 * A closure (Superseded / Done / No action) wins over the review state; a plain share can be
 * superseded too.
 */
export function artifactReviewPill(
  status: ArtifactReviewState | null | undefined,
  closure?: Pick<ArtifactLifecycleSnapshot, 'lifecycle' | 'supersededBy'> | null
): ArtifactReviewPill | null {
  if (closure?.supersededBy) {
    return {
      label: translate('auto.components.sessionArtifact.lifecycleSuperseded', 'Superseded'),
      className: CLOSED_PILL_CLASS
    }
  }
  if (closure?.lifecycle === 'done') {
    return {
      label: translate('auto.components.sessionArtifact.lifecycleDone', 'Done'),
      // Why semantic tokens: Done is confirmed closure, the same state the Artifacts table marks.
      className: 'border-status-success-border bg-status-success-background text-status-success'
    }
  }
  if (closure?.lifecycle === 'no_action') {
    return {
      label: translate('auto.components.sessionArtifact.lifecycleNoAction', 'No action'),
      className: CLOSED_PILL_CLASS
    }
  }
  switch (status) {
    case 'pending':
      return {
        label: translate('auto.components.sessionArtifact.reviewWaiting', 'Waiting'),
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      }
    case 'approved':
      return {
        label: translate('auto.components.sessionArtifact.reviewApproved', 'Approved'),
        className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      }
    case 'changes_requested':
      return {
        label: translate(
          'auto.components.sessionArtifact.reviewChangesRequested',
          'Changes requested'
        ),
        className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400'
      }
    case 'rejected':
      return {
        label: translate('auto.components.sessionArtifact.reviewRejected', 'Rejected'),
        className: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
      }
    case null:
    case undefined:
      return null
  }
}
