import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { BuildReviewEvent } from '../../../../shared/build-review-pipeline'
import { buildReviewActivity } from './build-review-activity'

function roleLabel(role: BuildReviewEvent['role']): string | null {
  switch (role) {
    case 'builder':
      return translate('auto.components.build-review.BuildReviewWorkerCard.builder', 'Builder')
    case 'reviewer':
      return translate('auto.components.build-review.BuildReviewWorkerCard.reviewer', 'Reviewer')
    case 'pipeline':
      return null
  }
}

/**
 * The run's event log, collapsed by default: the worker cards carry the live story, and this is
 * the audit trail behind it. Heartbeats and internal identifiers are left out.
 */
export function BuildReviewActivity({ events }: { events: readonly BuildReviewEvent[] }) {
  const [open, setOpen] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => buildReviewActivity(events), [events])
  useEffect(() => {
    if (open && log.current) {
      log.current.scrollTop = log.current.scrollHeight
    }
  }, [open, entries.length])
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-3">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group -ml-2">
          {translate('buildReview.activity.title', 'Activity')}
          <span className="font-normal tabular-nums text-muted-foreground">{entries.length}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={log}
          role="log"
          aria-label={translate('buildReview.activity.title', 'Activity')}
          className="mt-2 max-h-64 space-y-1 overflow-y-auto scrollbar-sleek rounded-md border p-3"
        >
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('buildReview.activity.empty', 'Nothing has happened yet.')}
            </p>
          ) : (
            entries.map((entry) => {
              const role = roleLabel(entry.role)
              return (
                <div key={entry.key} className="flex gap-3 text-xs">
                  <time
                    dateTime={entry.at}
                    className="shrink-0 font-mono tabular-nums text-muted-foreground"
                  >
                    {new Date(entry.at).toLocaleTimeString()}
                  </time>
                  <p
                    className={cn(
                      'min-w-0 whitespace-pre-wrap break-words',
                      entry.kind === 'error' && 'text-destructive'
                    )}
                  >
                    {role && <span className="mr-1.5 text-muted-foreground">{role}</span>}
                    {entry.text}
                  </p>
                </div>
              )
            })
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
