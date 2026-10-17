import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleJobEvent } from '../../../../shared/console-workflow-types'
import { WorkflowError } from './WorkflowFields'

export function WorkflowTimeline({
  jobId,
  replay = false,
  placement
}: {
  jobId: string
  replay?: boolean
  placement?: 'local' | 'fleet'
}) {
  return (
    <WorkflowTimelineEvents
      key={`${jobId}:${replay}:${placement}`}
      jobId={jobId}
      replay={replay}
      placement={placement}
    />
  )
}

function WorkflowTimelineEvents({
  jobId,
  replay,
  placement
}: {
  jobId: string
  replay: boolean
  placement?: 'local' | 'fleet'
}) {
  const [events, setEvents] = useState<ConsoleJobEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const cursor = useRef(0)
  const [more, setMore] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const result = workflowData(
          await consoleWorkflowApi().listJobEvents({
            jobId,
            limit: 200,
            ...(placement ? { placement } : {}),
            ...(replay ? { after: cursor.current } : {})
          })
        )
        if (result.job_id !== jobId) {
          throw new Error('The server returned events for a different job.')
        }
        if (!cancelled) {
          setEvents((previous) => (replay ? [...previous, ...result.events] : result.events))
          cursor.current = result.next_after ?? cursor.current
          setMore(replay && (result.has_more ?? result.events.length === 200))
          setError(null)
        }
      } catch (failure) {
        if (!cancelled) {
          setError(workflowErrorMessage(failure))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, replay, placement, revision])
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {translate('consoleWorkflows.timeline', 'Timeline')}
        </h2>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {more
            ? translate('consoleWorkflows.moreEvents', 'Load more events')
            : translate('consoleWorkflows.refreshEvents', 'Refresh events')}
        </Button>
      </div>
      <WorkflowError message={error} />
      {!replay && events.length === 200 && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'consoleWorkflows.recentEventsOnly',
            'Showing the 200 most recent events returned by the server.'
          )}
        </p>
      )}
      {loading && (
        <p className="text-sm text-muted-foreground">
          {translate('consoleWorkflows.loadingEvents', 'Loading server events…')}
        </p>
      )}
      {!loading && !error && !events.length && (
        <p className="text-sm text-muted-foreground">
          {translate('consoleWorkflows.noEvents', 'No events returned by the server.')}
        </p>
      )}
      <ol
        role="log"
        aria-label={translate('consoleWorkflows.serverEvents', 'Server events')}
        className="space-y-2"
      >
        {events.map((event) => (
          <li
            key={event.id}
            className="whitespace-pre-wrap break-words border-l border-border pl-3 font-mono text-xs"
          >
            <div className="text-muted-foreground">
              {event.created_at} · {event.kind} · {event.machine ?? jobId}
            </div>
            <div>{JSON.stringify(event.detail, null, 2)}</div>
          </li>
        ))}
      </ol>
    </section>
  )
}
