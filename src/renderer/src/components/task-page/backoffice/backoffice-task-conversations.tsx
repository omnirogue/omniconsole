import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  sessionAgentLabel,
  lastActionLabel
} from '@/components/sidebar/team-sessions/last-action-label'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { TaskConversation } from '../../../../../shared/console-workflow-types'

function conversationStateLabel(state: string): string {
  switch (state) {
    case 'running':
      return translate('unifiedWork.stateRunning', 'Running')
    case 'waiting':
      return translate('unifiedWork.stateWaiting', 'Waiting')
    case 'idle':
      return translate('unifiedWork.stateIdle', 'Idle')
    default:
      return translate('unifiedWork.stateEnded', 'Ended')
  }
}

function activitySummaryLabel(summary: TaskConversation['activitySummary']): string {
  if (!summary) {
    return ''
  }
  const parts: string[] = []
  if (summary.edits) {
    parts.push(translate('unifiedWork.summaryEdits', '{{value0}} edits', { value0: summary.edits }))
  }
  if (summary.commits) {
    parts.push(
      translate('unifiedWork.summaryCommits', '{{value0}} commits', { value0: summary.commits })
    )
  }
  if (summary.tests) {
    parts.push(translate('unifiedWork.summaryTests', '{{value0}} tests', { value0: summary.tests }))
  }
  if (summary.tool_calls) {
    parts.push(
      translate('unifiedWork.summaryToolCalls', '{{value0}} tool calls', {
        value0: summary.tool_calls
      })
    )
  }
  return parts.join(' · ')
}

export function BackofficeTaskConversationList({ taskId }: { taskId: string }) {
  const [data, setData] = useState<{ rows: TaskConversation[]; overflow: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let disposed = false
    void Promise.resolve()
      .then(() => consoleWorkflowApi().taskConversations({ taskId }))
      .then((result) => {
        const value = workflowData(result)
        if (!disposed) {
          setData(value)
          setError(null)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(workflowErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [taskId, revision])
  return (
    <section
      className="space-y-2"
      aria-label={translate('unifiedWork.conversations', 'Conversations')}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('unifiedWork.conversationsCount', 'Conversations ({{value0}})', {
            value0: data?.rows.length ?? 0
          })}
          {data && data.overflow > 0
            ? ` ${translate('unifiedWork.conversationsMore', '(+{{value0}} more)', { value0: data.overflow })}`
            : ''}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
          {translate('unifiedWork.refresh', 'Refresh')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.conversationsUnavailable', 'Conversations unavailable:')} {error}
        </p>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'unifiedWork.noConversations',
            'No conversations attached yet. Use Add to a task from a conversation.'
          )}
        </p>
      )}
      <ul className="space-y-2">
        {data?.rows.map((row) => {
          const detail =
            activitySummaryLabel(row.activitySummary) || lastActionLabel(row.lastAction)
          return (
            <li key={row.ledgerId} className="rounded-md border border-border p-2 text-xs">
              <p>{sessionAgentLabel(row.agent, row.model) || row.ledgerId}</p>
              <p className="text-muted-foreground">
                {row.employeeName ?? translate('unifiedWork.employeeUnknown', 'Unknown person')} ·{' '}
                {conversationStateLabel(row.state)} ·{' '}
                {formatUiRelativeTimeFromDate(row.lastActivityAt)}
              </p>
              {detail ? <p className="text-muted-foreground">{detail}</p> : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
