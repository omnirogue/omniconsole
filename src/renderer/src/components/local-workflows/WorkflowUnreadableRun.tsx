import { useState } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { runStateLabel } from './local-workflow-labels'
import { WorkflowPresetIcon } from './workflow-presets'

/**
 * A run whose records this version cannot read: an earlier version recorded them, or they are
 * damaged. It keeps the question, says in one plain sentence why it cannot be reopened, offers to
 * run the same question again, and keeps the host's own reasons behind Details: the person can
 * act, and nothing claims to need them.
 */
export function WorkflowUnreadableRun({
  view,
  onRunAgain
}: {
  view: LocalWorkflowView
  /** Opens a new conversation of the same preset, prefilled with this run's question. */
  onRunAgain?: () => void
}) {
  const [open, setOpen] = useState(false)
  const reported = view.error?.trim()
  return (
    <article className="space-y-5" data-execution-id={view.executionId}>
      {view.prompt ? (
        <div className="flex justify-end">
          <p
            className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm"
            aria-label={translate('localWorkflow.run.yourRequest', 'Your request')}
          >
            {view.prompt}
          </p>
        </div>
      ) : null}
      <div role="status" className="flex items-center gap-2 border-b pb-3 text-sm">
        <WorkflowPresetIcon
          preset={view.audit ? 'audit' : view.preset}
          className="size-4 text-muted-foreground"
        />
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
        <span className="font-medium">{runStateLabel(view.state)}</span>
      </div>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {view.unreadable === 'damaged'
            ? translate(
                'localWorkflow.run.unreadableDamaged',
                "This run's saved records are damaged, so it can't be reopened. Start it again to get a fresh result."
              )
            : translate(
                'localWorkflow.run.unreadable',
                "This run was recorded by an earlier version and can't be reopened. Start it again to get a fresh result."
              )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {onRunAgain ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onRunAgain}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {translate('localWorkflow.run.runAgain', 'Run again')}
            </Button>
          ) : null}
          {reported ? (
            <button
              type="button"
              aria-expanded={open}
              className="inline-flex items-center gap-0.5 rounded-sm font-mono text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => setOpen(!open)}
            >
              {translate('localWorkflow.run.details', 'Details')}
              <ChevronRight
                aria-hidden="true"
                className={cn('size-3 transition-transform', open && 'rotate-90')}
              />
            </button>
          ) : null}
        </div>
        {open && reported ? (
          <p className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
            {translate('localWorkflow.run.reportedError', 'Reported: {{error}}', {
              error: reported
            })}
          </p>
        ) : null}
      </div>
    </article>
  )
}
