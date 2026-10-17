import { translate } from '@/i18n/i18n'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { WorkEvent } from '../../../../../shared/console-work-home-contract'

export function BackofficeTaskActivity({
  taskId,
  names
}: {
  taskId: string
  names: ReadonlyMap<string, string>
}) {
  const [events, setEvents] = useState<WorkEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [revision, setRevision] = useState(0)
  const [limit, setLimit] = useState(30)
  useEffect(() => {
    let disposed = false,
      reading = false
    const read = async () => {
      if (reading) {
        return
      }
      reading = true
      try {
        const value = workflowData(await consoleWorkflowApi().listTaskActivity({ taskId }))
        if (!disposed) {
          setEvents(value)
          setError(null)
        }
      } catch (reason) {
        if (!disposed) {
          setError(workflowErrorMessage(reason))
          setEvents(null)
        }
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void read()
      }
    }, 30_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [taskId, revision])
  const save = async () => {
    if (busy.current || !note.trim()) {
      return
    }
    busy.current = true
    setPending(true)
    try {
      workflowData(await consoleWorkflowApi().addTaskNote({ taskId, note: note.trim() }))
      setNote('')
      setRevision((value) => value + 1)
    } catch (reason) {
      setError(
        `${workflowErrorMessage(reason)} Check activity before retrying; the note may have been saved.`
      )
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <section
      className="space-y-3"
      aria-label={translate('unifiedWork.93dda1c5627a', 'Notes and activity')}
    >
      <h3 className="text-sm font-semibold">
        {translate('unifiedWork.93dda1c5627a', 'Notes and activity')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'unifiedWork.b88ed208a844',
          'Human and AI entries share this task trail. A note does not approve an action.'
        )}
      </p>
      <Textarea
        aria-label={translate('unifiedWork.b907642ec4a6', 'New task note')}
        value={note}
        maxLength={4000}
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button size="sm" disabled={pending || !note.trim()} onClick={() => void save()}>
        {pending
          ? translate('unifiedWork.23e39291d613', 'Saving…')
          : translate('unifiedWork.63565c0485fe', 'Add note')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.2380183ff94b', 'Activity unavailable:')}
          {error}
        </p>
      )}
      {events && !events.length && (
        <p className="text-xs text-muted-foreground">
          {translate('unifiedWork.3deaca045f84', 'No activity returned.')}
        </p>
      )}
      <ol className="space-y-2">
        {events
          ?.toReversed()
          .slice(0, limit)
          .map((event) => (
            <li key={event.id} className="rounded-md border border-border p-2">
              <p className="text-xs text-muted-foreground">
                {names.get(event.actor) ?? event.actor} · {event.created_at} ·{' '}
                {event.event === 'comment'
                  ? translate('unifiedWork.d8da2c49df39', 'Note')
                  : event.event}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{event.note}</p>
              {event.to_status && (
                <p className="text-xs">
                  {event.from_status ?? '—'} → {event.to_status}
                </p>
              )}
              {event.payload != null && (
                <details className="text-xs">
                  <summary>{translate('unifiedWork.e81efe09c664', 'Evidence and context')}</summary>
                  <pre className="overflow-auto scrollbar-sleek whitespace-pre-wrap">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
      </ol>
      {events && events.length > limit && (
        <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + 30)}>
          {translate('unifiedWork.a9a6d95d12ae', 'Show more activity')}
        </Button>
      )}
    </section>
  )
}
