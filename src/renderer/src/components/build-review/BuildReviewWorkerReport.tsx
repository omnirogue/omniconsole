import { useState } from 'react'
import { FileText } from 'lucide-react'
import { WorkflowMarkdown } from '@/components/local-workflows/WorkflowMarkdown'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { reportSeverityCounts } from './build-review-report-findings'
import { BuildReviewSeverityChips } from './BuildReviewVerdict'
import { BuildReviewCheckedFindings } from './BuildReviewCheckedFindings'
import { canOpenWorkerReport, openWorkerReport } from './open-worker-report'

/**
 * What a worker reported: its subject, the report as the same document markdown chat uses (a
 * reviewer's with the severities it ranked), the files it changed, and the full report file when
 * the message is only its summary.
 */
export function BuildReviewWorkerReport({
  report,
  role,
  worktreeId,
  findings = null
}: {
  report: NonNullable<BuildReviewWorkerSnapshot['report']>
  role: BuildReviewWorkerSnapshot['role']
  /** The run's workspace; the full report opens in the app's viewer against it. */
  worktreeId?: string | null
  /** A reviewer's findings with the host's check of each blocker. */
  findings?: BuildReviewWorkerSnapshot['findings']
}) {
  const body = report.body.trim()
  const reportPath = report.reportPath
  return (
    <div className="space-y-2" data-build-review-report>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium">{report.subject}</h4>
        {role === 'reviewer' && (
          <BuildReviewSeverityChips counts={reportSeverityCounts(body, report.subject)} />
        )}
      </div>
      {findings && <BuildReviewCheckedFindings findings={findings} />}
      {body && (
        <div className="max-h-96 overflow-y-auto scrollbar-sleek pr-1">
          <WorkflowMarkdown content={body} variant="document" />
        </div>
      )}
      {canOpenWorkerReport(reportPath, worktreeId) && worktreeId && (
        <OpenFullReportButton reportPath={reportPath} worktreeId={worktreeId} />
      )}
      {report.filesModified.length > 0 && (
        <div>
          <h5 className="mb-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.build-review.BuildReviewWorkerCard.files',
              'Files modified'
            )}
          </h5>
          <ul className="space-y-0.5 font-mono text-xs">
            {report.filesModified.map((file, index) => (
              <li key={`${index}:${file}`} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Opens the reviewer's full report, and says so in words when it cannot: a dead click reads as broken. */
function OpenFullReportButton({
  reportPath,
  worktreeId
}: {
  reportPath: string
  worktreeId: string
}) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        title={reportPath}
        onClick={async () => {
          setFailed(false)
          try {
            await openWorkerReport(reportPath, worktreeId)
          } catch {
            setFailed(true)
          }
        }}
      >
        <FileText aria-hidden="true" />
        {translate('buildReview.report.openFull', 'Open full report')}
      </Button>
      {failed && (
        <p role="alert" className="break-all text-xs text-destructive">
          {translate(
            'buildReview.report.openFailed',
            'The report at {{path}} could not be opened.',
            {
              path: reportPath
            }
          )}
        </p>
      )}
    </div>
  )
}
