import { memo, useMemo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import { sessionGoalGroups, type SessionGoalGroup } from '../../../../shared/session-goal-groups'
import { goalsTodosKey } from './goals-todos-rows'
import { sessionTodoBadge } from './goals-todos-text'
import { goalHeadline, MilestoneMark, milestoneSentence } from './SessionProgress'
import { useApprovedSessionPullRequests } from './session-approvals'
import { useKnownPullRequestFacts } from './session-pull-request-facts-store'
import { useGoalsTodosEntry } from './use-goals-todos-details'

/** The current goal's mark beside the row name; the hover lists its milestones. */
function GoalBadge({ goal }: { goal: SessionGoalGroup }): React.JSX.Element {
  const headline = goalHeadline(goal)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-auto inline-flex shrink-0 scale-90"
          data-session-goal-badge={headline.status}
        >
          <MilestoneMark status={headline.status} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72 space-y-0.5 text-left">
        <p className="line-clamp-2 font-medium">{goal.title}</p>
        {goal.milestones.map((milestone) => (
          <p key={milestone.key}>
            {milestone.status === 'done' ? '✓ ' : '○ '}
            {milestoneSentence(milestone)}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Beside a Conversations row's name: the current goal's progress mark when its pull requests
 * are known, else "3/7" for a to-do list, else nothing. It only shows what the shared reads
 * already cached — a row never starts a read.
 */
export const SessionRowTodoBadge = memo(function SessionRowTodoBadge({
  session
}: {
  session: SidebarSession
}): React.JSX.Element | null {
  const details = useGoalsTodosEntry(goalsTodosKey(session))
  const known = useKnownPullRequestFacts()
  const approved = useApprovedSessionPullRequests()
  const goal = useMemo(
    () =>
      details?.pullRequests?.length
        ? (sessionGoalGroups(details.pullRequests, known, approved).at(-1) ?? null)
        : null,
    [details, known, approved]
  )
  const badge = useMemo(() => sessionTodoBadge(details), [details])
  if (goal) {
    return <GoalBadge goal={goal} />
  }
  if (!badge) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-normal leading-none tabular-nums',
            badge.done ? 'text-status-success' : 'text-muted-foreground'
          )}
          aria-label={badge.label}
          data-session-todo-badge={badge.text}
        >
          {badge.text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72 space-y-0.5 text-left">
        {badge.goal ? <p className="line-clamp-3 font-medium">{badge.goal}</p> : null}
        <p>{badge.label}</p>
        {badge.step ? <p className="line-clamp-2">{badge.step}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
})
