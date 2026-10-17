import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  reviewFindingBlocks,
  type CheckedReviewFinding,
  type ReviewEvidenceStatus
} from '../../../../shared/review-findings'

const STATUS_LABELS: Record<ReviewEvidenceStatus, () => string> = {
  confirmed: () => translate('buildReview.evidence.confirmed', 'Reproduced in an earlier version'),
  located: () => translate('buildReview.evidence.located', 'Located (not proven), still blocking'),
  'not-reproduced': () =>
    translate(
      'buildReview.evidence.notReproduced',
      'Not reproduced (earlier version), still blocking'
    ),
  unverified: () =>
    translate(
      'buildReview.evidence.unverified',
      'Not verified (for example, quote not found), still blocking'
    ),
  'needs-evidence': () => translate('buildReview.evidence.needsEvidence', 'No evidence')
}

// A run saved by a newer version may carry a status this one does not know.
function statusLabel(status: ReviewEvidenceStatus): string {
  return Object.hasOwn(STATUS_LABELS, status)
    ? STATUS_LABELS[status]()
    : translate('buildReview.evidence.unknown', 'Not proven; the evidence status is unknown')
}

/** A reviewer's blockers with what the host saw checking each; only blocking ones are red. */
export function BuildReviewCheckedFindings({
  findings
}: {
  findings: readonly CheckedReviewFinding[]
}) {
  const blockers = findings.filter((finding) => finding.severity === 'blocker')
  if (blockers.length === 0) {
    return null
  }
  return (
    <div className="space-y-1" data-build-review-evidence>
      <h5 className="text-xs text-muted-foreground">
        {translate('buildReview.evidence.title', 'Blockers, as the host checked them')}
      </h5>
      <ul className="space-y-1 text-xs">
        {blockers.map((finding) => (
          <li key={finding.id} className="flex flex-wrap items-start gap-2">
            <Badge
              variant="outline"
              data-build-review-evidence-status={finding.status}
              className={cn(
                'shrink-0 font-normal',
                reviewFindingBlocks(finding)
                  ? 'border-destructive/40 text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {statusLabel(finding.status)}
            </Badge>
            <span className="min-w-0 flex-1 break-words">
              {finding.id}: {finding.claim}
              {finding.location ? ` (${finding.location})` : ''}
              {finding.detail ? (
                <span className="block text-muted-foreground">{finding.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
