import { AlertTriangle, Clock, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  WorkflowWebTrail,
  WorkflowWebTrailSource
} from '../../../../shared/workflow-web-trail'
import { webPageReasonLabel } from './web-page-reason-label'

const READ_AT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
})

function readText(source: WorkflowWebTrailSource): string {
  const parts = [
    source.readAt
      ? translate('workflowGraph.web.sources.readAt', 'read {{time}}', {
          time: READ_AT.format(new Date(source.readAt))
        })
      : translate('workflowGraph.web.sources.read', 'read')
  ]
  if (source.removedLines) {
    parts.push(
      source.removedLines === 1
        ? translate(
            'workflowGraph.web.sources.removedOne',
            '1 line removed that read as instructions to AI'
          )
        : translate(
            'workflowGraph.web.sources.removed',
            '{{count}} lines removed that read as instructions to AI',
            { count: source.removedLines }
          )
    )
  }
  if (source.truncated) {
    parts.push(
      translate('workflowGraph.web.sources.truncated', 'cut to its first 60,000 characters')
    )
  }
  return parts.join(' · ')
}

function stateText(source: WorkflowWebTrailSource): string {
  switch (source.state) {
    case 'read':
      return readText(source)
    case 'unreadable':
      return translate('workflowGraph.web.sources.unreadable', 'could not be read: {{why}}', {
        why: webPageReasonLabel(source.reason)
      })
    case 'pending':
      return translate('workflowGraph.web.sources.pending', 'not read yet')
    case 'not-kept':
      return translate(
        'workflowGraph.web.sources.notKept',
        'not read: the app holds no checked copy of it'
      )
  }
}

function StateIcon({ state }: { state: WorkflowWebTrailSource['state'] }) {
  switch (state) {
    case 'read':
      return (
        <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )
    case 'pending':
      return <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    case 'unreadable':
    case 'not-kept':
      return (
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-status-warning"
          data-web-icon="warning"
        />
      )
  }
}

/** The run's pages as the app kept them: address and state only, never text a page wrote. */
export function WorkflowWebSources({ trail }: { trail: WorkflowWebTrail }) {
  const title = translate(
    'workflowGraph.web.sources.title',
    'Sources ({{read}} of {{total}} read)',
    {
      read: trail.read,
      total: trail.sources.length
    }
  )
  return (
    <section
      aria-label={translate('workflowGraph.web.sources.label', 'Sources')}
      className="space-y-1.5 rounded-lg border bg-card p-3 text-xs"
      data-workflow-web-sources=""
    >
      <p className="font-medium">{title}</p>
      <ul className="space-y-1">
        {trail.sources.map((source) => {
          const warn = source.state === 'unreadable' || source.state === 'not-kept'
          return (
            <li
              key={source.id}
              data-web-state={source.state}
              className={cn('flex items-start gap-1.5', warn && 'text-status-warning')}
            >
              <StateIcon state={source.state} />
              <span className="min-w-0 break-words">
                {`${source.id} · `}
                <bdi className="font-mono">{source.address}</bdi>
                {` · ${stateText(source)}`}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
