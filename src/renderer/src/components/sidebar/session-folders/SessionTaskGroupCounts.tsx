import { CircleCheck, CircleDot, Hourglass } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { translate } from '@/i18n/i18n'
import type { SessionTaskGroupCounts as Counts } from '@/lib/session-task-sidebar-groups'
import { cn } from '@/lib/utils'

/** A task group's live state at a glance: how many of its sessions need you, run, wait or are done. */
export function SessionTaskGroupCounts({ counts }: { counts: Counts }): React.JSX.Element {
  const parts = [
    {
      state: 'needsYou',
      count: counts.needsYou,
      Icon: AgentQuestionIcon,
      label: translate('conversations.taskCountNeedsYou', '{{count}} need you', {
        count: counts.needsYou
      })
    },
    {
      state: 'running',
      count: counts.running,
      Icon: CircleDot,
      label: translate('conversations.taskCountRunning', '{{count}} running', {
        count: counts.running
      })
    },
    {
      state: 'waiting',
      count: counts.waiting,
      Icon: Hourglass,
      label: translate('conversations.taskCountWaiting', '{{count}} waiting', {
        count: counts.waiting
      })
    },
    {
      state: 'done',
      count: counts.done,
      Icon: CircleCheck,
      label: translate('conversations.taskCountDone', '{{count}} done', { count: counts.done })
    }
  ].filter((part) => part.count > 0)
  return (
    <span className="flex shrink-0 items-center gap-1" data-session-task-counts="">
      {counts.outcomes && counts.outcomes.total > 0 && (
        <span className="text-xs text-muted-foreground" data-session-task-count="outcomes">
          {translate('taskOutcomes.count', '{{satisfied}}/{{total}} outcomes', counts.outcomes)}
        </span>
      )}
      {parts.map(({ state, count, Icon, label }) => (
        <span
          key={state}
          role="img"
          aria-label={label}
          data-session-task-count={state}
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full px-1 text-[10px] font-semibold tabular-nums leading-4',
            state === 'needsYou'
              ? 'bg-agent-question/15 text-agent-question-text'
              : 'text-muted-foreground'
          )}
        >
          <Icon className="size-2.5" />
          {count}
        </span>
      ))}
    </span>
  )
}
