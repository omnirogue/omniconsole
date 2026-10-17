import { memo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionActivityTodoList } from '@/components/session-activity/SessionActivityTodoList'
import {
  activityAbsoluteTime,
  activityAgeLabel
} from '@/components/session-activity/session-activity-text'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GoalsTodosRow } from './goals-todos-rows'
import { GoalsTodosProgressLine } from './GoalsTodosProgressLine'

/** One session: what it is for, how far through its list it is, and when it last moved. */
export const GoalsTodosRowItem = memo(function GoalsTodosRowItem({
  row,
  now
}: {
  row: GoalsTodosRow
  now: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasList = row.total > 0
  const canExpand = hasList || row.goal !== null
  const goalTitle = row.goal?.full ?? row.heading
  return (
    <li className="rounded-md px-2 py-1.5 text-xs hover:bg-worktree-sidebar-accent/50">
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => openSidebarSession(row.session)}
          aria-label={translate('goalsTodos.open', 'Open {{title}}', { title: row.heading })}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0">
              <AgentIcon agent={(row.session.agent as TuiAgent | null) ?? null} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium" title={goalTitle}>
              {row.heading}
            </span>
            {row.updatedAt !== null ? (
              <span
                className="shrink-0 text-muted-foreground"
                title={activityAbsoluteTime(row.updatedAt)}
              >
                {activityAgeLabel(row.updatedAt, now)}
              </span>
            ) : null}
          </div>
          {row.goalLine ? (
            <p className="min-w-0 truncate text-muted-foreground" title={goalTitle}>
              {row.goalLine}
            </p>
          ) : null}
          <p className="min-w-0 truncate text-muted-foreground/80">{row.session.workspaceLabel}</p>
          {hasList ? (
            <GoalsTodosProgressLine progress={row} />
          ) : (
            <p className="text-muted-foreground italic">
              {translate('goalsTodos.noList', 'No to-do list yet')}
            </p>
          )}
        </button>
        {canExpand ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? translate('goalsTodos.hideDetails', 'Hide goal and to-do list')
                : translate('goalsTodos.showDetails', 'Show goal and to-do list')
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1.5 space-y-1.5 border-l border-border pl-2">
          {row.goal ? (
            <div>
              <p className="font-medium text-muted-foreground">
                {translate('goalsTodos.goalLabel', 'Goal')}
              </p>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words scrollbar-sleek">
                {row.goal.full}
              </p>
            </div>
          ) : null}
          {hasList ? (
            <div>
              <p className="font-medium text-muted-foreground">
                {row.source === 'text'
                  ? translate('goalsTodos.writtenPlan', "To-do list (from the AI's written plan)")
                  : translate('goalsTodos.listLabel', 'To-do list')}
              </p>
              <SessionActivityTodoList todos={row.todos} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})
