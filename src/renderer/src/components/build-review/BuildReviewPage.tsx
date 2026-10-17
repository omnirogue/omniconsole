import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { openBuildReview } from '@/lib/build-review-entry'
import { formatRelativeTime } from '@/components/task-page/relative-time'
import { isBuildReviewActive } from '../../../../shared/build-review-pipeline'
import { WorkflowPresetIcon } from '../local-workflows/workflow-presets'
import { BuildReviewDetail } from './BuildReviewDetail'
import { buildReviewStatusLabel } from './build-review-labels'

export default function BuildReviewPage() {
  const state = useAppStore((s) => s.buildReview)
  const refreshAll = state.refreshAll
  const refreshLocalWorkflowStatuses = useAppStore((s) => s.refreshLocalWorkflowStatuses)
  // Why both: a manual refresh also re-reads workflow runs whose status read failed (C6).
  const refreshRuns = (): void => {
    void refreshAll()
    refreshLocalWorkflowStatuses()
  }
  const pipelines = Object.values(state.pipelinesById).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )
  const selected = pipelines.find((p) => p.id === state.selectedPipelineId) ?? pipelines[0]
  const active = pipelines.some((p) => isBuildReviewActive(p.stage))
  useEffect(() => {
    void refreshAll()
  }, [refreshAll])
  useEffect(() => {
    if (!active) {
      return
    }
    // Why slow: every change is pushed (buildReview:changed refreshes the store); this only
    // catches a missed push, as the workflow views' fallback poll does.
    const timer = window.setInterval(() => void refreshAll(), 10_000)
    return () => window.clearInterval(timer)
  }, [active, refreshAll])
  const newButton = (
    <Button size="sm" onClick={() => openBuildReview()}>
      <Plus />
      {translate('auto.components.build-review.BuildReviewPage.new', 'New Build + Review')}
    </Button>
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <WorkflowPresetIcon preset="build-review" className="text-muted-foreground" />
          {translate('auto.components.build-review.BuildReviewPage.title', 'Build + Review')}
        </h1>
        {newButton}
      </header>
      {state.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b p-3 text-sm text-destructive"
        >
          <p>{state.error}</p>
          <Button size="sm" variant="outline" onClick={() => refreshRuns()}>
            {translate('auto.components.build-review.BuildReviewPage.retry', 'Retry')}
          </Button>
        </div>
      )}
      {pipelines.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <WorkflowPresetIcon preset="build-review" className="size-8 text-muted-foreground" />
          <h2 className="text-sm font-medium">
            {translate(
              'auto.components.build-review.BuildReviewPage.empty',
              'No build and review pipelines yet'
            )}
          </h2>
          {newButton}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={translate('auto.components.build-review.BuildReviewPage.list', 'Pipelines')}
            className="w-72 shrink-0 overflow-y-auto scrollbar-sleek border-r p-2"
          >
            {pipelines.map((pipeline) => (
              <button
                type="button"
                key={pipeline.id}
                onClick={() => state.select(pipeline.id)}
                data-current={selected?.id === pipeline.id}
                aria-current={selected?.id === pipeline.id ? 'true' : undefined}
                className={cn(
                  'mb-1 w-full space-y-2 rounded-md p-3 text-left hover:bg-accent',
                  selected?.id === pipeline.id && 'bg-accent'
                )}
              >
                <p className="line-clamp-2 text-sm font-medium">{pipeline.objective}</p>
                <Badge variant="secondary">{buildReviewStatusLabel(pipeline.stage)}</Badge>
                <p className="text-xs text-muted-foreground">
                  {pipeline.builder.choice.agent} →{' '}
                  {(pipeline.reviewers ?? [pipeline.reviewer])
                    .map((reviewer) => reviewer.choice.agent)
                    .join(', ')}
                </p>
                <time dateTime={pipeline.updatedAt} className="text-xs text-muted-foreground">
                  {formatRelativeTime(pipeline.updatedAt)}
                </time>
              </button>
            ))}
          </nav>
          <main className="min-w-0 flex-1 overflow-y-auto scrollbar-sleek">
            {selected && (
              <BuildReviewDetail
                key={selected.id}
                pipeline={selected}
                className="p-6"
                liveTerminal
              />
            )}
          </main>
        </div>
      )}
    </div>
  )
}
