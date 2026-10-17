import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { workflowErrorText, workflowErrorWasTranslated } from './workflow-error-text'

/**
 * Why the run failed, in plain words. When those differ from what the host reported (a bare code
 * such as `worker_exit_unclean`), a Details toggle holds the original, as an agent's card does:
 * the run has no other place that would show it.
 */
export function WorkflowRunError({ error }: { error: string }) {
  const [open, setOpen] = useState(false)
  const reported = error.trim()
  return (
    <div role="alert" className="space-y-1">
      <p className="text-sm text-destructive">{workflowErrorText(reported, 'run')}</p>
      {workflowErrorWasTranslated(reported) ? (
        <>
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
          {open ? (
            <p className="break-words font-mono text-[11px] text-muted-foreground">
              {translate('localWorkflow.run.reportedError', 'Reported: {{error}}', {
                error: reported
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
