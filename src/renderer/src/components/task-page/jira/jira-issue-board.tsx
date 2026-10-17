import React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../../../shared/jira-types'
import { JIRA_ITEM_LIMIT } from '../task-page-list-limits'
import { groupJiraBoardIssues, jiraBoardIssueIdentity } from './jira-board-columns'

type JiraIssueBoardProps = {
  issues: readonly JiraIssue[]
  loadedCount: number
  selectedIssue: JiraIssue | null
  onOpenIssue: (issue: JiraIssue) => void
}

export function JiraIssueBoard({
  issues,
  loadedCount,
  selectedIssue,
  onOpenIssue
}: JiraIssueBoardProps): React.JSX.Element {
  const columns = groupJiraBoardIssues(issues)
  const selectedIdentity = selectedIssue ? jiraBoardIssueIdentity(selectedIssue) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.jiraBoard.scope',
          'Columns show the loaded Jira results. Open a card to edit it in Jira; refresh to see updates from colleagues.'
        )}
        {loadedCount >= JIRA_ITEM_LIMIT ? (
          <span className="ml-1">
            {translate(
              'auto.components.jiraBoard.limited',
              'More issues may exist. Narrow the project or JQL query, or open the full board in Jira.'
            )}
          </span>
        ) : null}
      </p>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 scrollbar-sleek">
        {[...columns].map(([column, items]) => (
          <section
            key={column}
            aria-label={column}
            className="flex min-h-0 w-64 shrink-0 flex-col rounded-md border border-border bg-muted/35"
          >
            <h3 className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-xs font-medium">
              <span>{column}</span>
              <span className="text-muted-foreground">{items.length}</span>
            </h3>
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2 scrollbar-sleek">
              {items.map((issue) => {
                const identity = jiraBoardIssueIdentity(issue)
                return (
                  <Button
                    key={identity}
                    variant="outline"
                    aria-current={identity === selectedIdentity ? 'true' : undefined}
                    onClick={() => onOpenIssue(issue)}
                    className={cn(
                      'h-auto w-full shrink-0 flex-col items-start gap-2 whitespace-normal bg-card p-3 text-left shadow-xs',
                      identity === selectedIdentity && 'bg-accent'
                    )}
                  >
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {issue.siteName ? `${issue.siteName} / ` : ''}
                      {issue.key}
                    </span>
                    <span className="text-[13px] font-medium break-words">{issue.title}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {issue.status.name} ·{' '}
                      {issue.assignee?.displayName ??
                        translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
                    </span>
                    {issue.priority ? (
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {issue.priority.name}
                      </span>
                    ) : null}
                  </Button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
