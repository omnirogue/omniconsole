import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { LocalRunLivePane } from '../local-run/LocalRunLivePane'
import {
  formatWorkerElapsed,
  workerActivity,
  workerMessagePreview
} from './build-review-worker-live'

/**
 * What a started worker is doing right now, read from its agent hooks: the tool it is using,
 * how long it has been in this state, and the start of what it last said.
 */
export function BuildReviewWorkerLiveStatus({
  worker,
  row
}: {
  worker: BuildReviewWorkerSnapshot
  row: AgentStatusEntry | null
}) {
  const activity = workerActivity(worker, row)
  const since = row?.stateStartedAt ?? null
  const now = useNow(1000, activity !== null && since !== null)
  if (!activity) {
    return null
  }
  const preview = workerMessagePreview(row)
  return (
    <div className="min-w-0 space-y-1 text-xs" data-build-review-live>
      <p className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate" title={activity}>
          {activity}
        </span>
        {since !== null && (
          // Why aria-hidden: a clock that changes every second would be read out every second.
          <span
            aria-hidden="true"
            className="shrink-0 font-mono tabular-nums text-muted-foreground"
          >
            {formatWorkerElapsed(now - since)}
          </span>
        )}
      </p>
      {preview && (
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">
          {preview}
        </p>
      )}
    </div>
  )
}

/**
 * The running worker's own terminal, inline and collapsible. It is the live pane Local runs
 * uses: the real terminal moves here, so there is no second PTY and no copied output.
 */
export function BuildReviewWorkerLiveTerminal({
  handle,
  actions
}: {
  handle: string
  /** Buttons that sit beside the show/hide toggle (Open terminal). */
  actions?: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-2">
      <CollapsibleContent>
        <LocalRunLivePane handle={handle} owner="buildReview" />
      </CollapsibleContent>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group">
            {open
              ? translate('buildReview.live.hideTerminal', 'Hide live terminal')
              : translate('buildReview.live.showTerminal', 'Show live terminal')}
            <ChevronDown
              aria-hidden="true"
              className="size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
            />
          </Button>
        </CollapsibleTrigger>
      </div>
    </Collapsible>
  )
}
