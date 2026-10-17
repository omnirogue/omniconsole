import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { BuildReviewWorkerVerdict } from './build-review-progress'
import {
  BUILD_REVIEW_SEVERITIES,
  type BuildReviewSeverity,
  type BuildReviewSeverityCounts
} from './build-review-report-findings'

function verdictLabel(verdict: BuildReviewWorkerVerdict): string {
  switch (verdict) {
    case 'approved':
      return translate('buildReview.approved', 'Approved')
    case 'changes-requested':
      return translate('buildReview.changesRequested', 'Changes requested')
    case 'missing':
      return translate('buildReview.verdictMissing', 'Verdict missing')
  }
}

/** A reviewer's (or the run's) verdict. Colour is the state: green approved, amber changes. */
export function BuildReviewVerdictBadge({
  verdict,
  className
}: {
  verdict: BuildReviewWorkerVerdict
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      data-build-review-verdict={verdict}
      className={cn(
        verdict === 'approved' &&
          'border-status-success-border bg-status-success-background text-status-success',
        verdict === 'changes-requested' &&
          'border-status-warning-border bg-status-warning-background text-status-warning',
        verdict === 'missing' && 'border-destructive/40 text-destructive',
        className
      )}
    >
      {verdictLabel(verdict)}
    </Badge>
  )
}

function severityLabel(severity: BuildReviewSeverity): string {
  switch (severity) {
    case 'blocker':
      return translate('buildReview.severity.blocker', 'Blocker')
    case 'major':
      return translate('buildReview.severity.major', 'Major')
    case 'minor':
      return translate('buildReview.severity.minor', 'Minor')
    case 'nit':
      return translate('buildReview.severity.nit', 'Nit')
  }
}

/** One chip per severity the report names, with its count; nothing when it names none. */
export function BuildReviewSeverityChips({ counts }: { counts: BuildReviewSeverityCounts }) {
  const present = BUILD_REVIEW_SEVERITIES.filter((severity) => counts[severity] > 0)
  if (present.length === 0) {
    return null
  }
  return (
    <ul
      className="flex flex-wrap items-center gap-1"
      aria-label={translate('buildReview.severity.label', 'Findings by severity')}
    >
      {present.map((severity) => (
        <li key={severity}>
          <Badge
            variant="outline"
            data-build-review-severity={severity}
            className={cn(
              'gap-1 font-normal',
              severity === 'blocker' && 'border-destructive/40 text-destructive',
              severity === 'major' && 'border-status-warning-border text-status-warning',
              (severity === 'minor' || severity === 'nit') && 'text-muted-foreground'
            )}
          >
            {severityLabel(severity)}
            <span className="font-medium tabular-nums">{counts[severity]}</span>
          </Badge>
        </li>
      ))}
    </ul>
  )
}
