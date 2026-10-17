import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import type { LocalWorkflowDiscoverRun } from '../../../../shared/local-workflow-view'
import type { DiscoverReportItem } from './discover-run-text'
import { SeverityChip, WorkflowLocation } from './DiscoverFindingCard'
import { WorkflowPresetIcon } from './workflow-presets'

function ReportItem({
  item,
  onOpenLocation,
  onFix
}: {
  item: DiscoverReportItem
  onOpenLocation?: (location: string) => void
  onFix?: (item: DiscoverReportItem) => void
}) {
  return (
    <li className="flex gap-3 border-t px-4 py-4 first:border-t-0">
      <span className="w-5 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums text-muted-foreground">
        {item.rank}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityChip severity={item.severity} />
          <h4 className="min-w-0 text-sm font-medium">{item.title}</h4>
          {item.parallelSafe && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {translate('localWorkflow.discoverRun.parallelSafe', 'Can run in parallel')}
            </Badge>
          )}
        </div>
        <WorkflowLocation location={item.location} onOpen={onOpenLocation} />
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {translate('localWorkflow.discoverRun.scenario', 'What goes wrong')}
            </p>
            <WorkflowMarkdown className="text-sm" content={item.scenario} />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {translate('localWorkflow.discoverRun.fix', 'Fix')}
            </p>
            <WorkflowMarkdown className="text-sm" content={item.fix} />
          </div>
        </div>
        {onFix && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => onFix(item)}
          >
            <WorkflowPresetIcon preset="build-review" className="size-3.5" />
            {translate('localWorkflow.discoverRun.fixWithBuildReview', 'Fix with Build + Review')}
          </Button>
        )}
      </div>
    </li>
  )
}

/** After Rank: what held up, ranked by blast radius, each one a click away from a fix. */
export function DiscoverReport({
  report,
  fallbackMarkdown,
  completed,
  onOpenLocation,
  onFix,
  footer
}: {
  report?: LocalWorkflowDiscoverRun['report']
  /** Legacy runs publish only a markdown result. */
  fallbackMarkdown?: string
  completed: boolean
  onOpenLocation?: (location: string) => void
  onFix?: (item: DiscoverReportItem) => void
  footer?: ReactNode
}) {
  const summary = report?.summary.trim() || fallbackMarkdown
  return (
    <section
      aria-label={translate('localWorkflow.discoverRun.report', 'Report')}
      className={cn('rounded-xl border bg-card', completed && 'border-status-success-border')}
    >
      {summary ? (
        <div className="px-4 pt-4">
          <WorkflowMarkdown className="text-sm" content={summary} />
        </div>
      ) : null}
      {report && report.items.length > 0 ? (
        <ol className="mt-2">
          {report.items.map((item) => (
            <ReportItem
              key={`${item.rank}-${item.location}`}
              item={item}
              onOpenLocation={onOpenLocation}
              onFix={onFix}
            />
          ))}
        </ol>
      ) : report ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {translate(
            'localWorkflow.discoverRun.nothingHeld',
            'Nothing held up under verification.'
          )}
        </p>
      ) : null}
      {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
    </section>
  )
}
