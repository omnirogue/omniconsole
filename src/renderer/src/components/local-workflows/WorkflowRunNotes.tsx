import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { countWorkflowNotes } from './workflow-run-notes'

function WorkflowNoteList({ entries }: { entries: readonly string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
      {countWorkflowNotes(entries).map(([entry, count]) => (
        <li key={entry}>
          {entry}
          {count > 1 ? (
            <span className="tabular-nums">
              {' '}
              {translate('localWorkflow.discoverRun.droppedTimes', '(×{{count}})', { count })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The program's own log (rounds started, caps that dropped work, members that did not answer),
 * folded behind a quiet toggle below the run so it never crowds the header or the result.
 * Nothing is silent: every dropped piece of work is listed here, one click away.
 */
export function WorkflowRunNotes({ entries }: { entries: readonly string[] }) {
  const [open, setOpen] = useState(false)
  if (!entries.length) {
    return null
  }
  return (
    <section
      aria-label={translate('localWorkflow.run.notes', 'Notes')}
      className="space-y-1.5"
      data-workflow-notes=""
    >
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3 transition-transform', open && 'rotate-90')}
        />
        {translate('localWorkflow.run.notesCount', 'Notes · {{count}}', {
          count: countWorkflowNotes(entries).length
        })}
      </button>
      {open ? <WorkflowNoteList entries={entries} /> : null}
    </section>
  )
}
