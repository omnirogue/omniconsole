import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SessionGoalGroup } from '../../../../shared/session-goal-groups'
import type {
  SessionMilestone,
  SessionMilestoneStatus
} from '../../../../shared/session-milestones'

function statusLabel(status: SessionMilestoneStatus): string {
  switch (status) {
    case 'done':
      return translate('sessionProgress.statusDone', 'Done')
    case 'now':
      return translate('sessionProgress.statusNow', 'In progress')
    case 'you':
      return translate('sessionProgress.statusYou', 'Waiting on you')
    case 'fail':
      return translate('sessionProgress.statusFail', 'Blocked')
    case 'todo':
      return translate('sessionProgress.statusTodo', 'Not started')
  }
}

/**
 * ✓ solid green only for a proven milestone; the AI's own ticked steps keep their outline check.
 * `now` pulses (motion-safe), `you` is amber, `fail` red, `todo` an empty ring.
 */
export function MilestoneMark({ status }: { status: SessionMilestoneStatus }): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      data-session-milestone-mark={status}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full',
        status === 'done' && 'bg-status-success text-background',
        status === 'now' && 'border-2 border-status-info',
        status === 'you' && 'bg-status-warning text-background',
        status === 'fail' && 'bg-destructive text-background',
        status === 'todo' && 'border-[1.5px] border-muted-foreground/50'
      )}
    >
      {status === 'done' ? <Check className="size-2.5" strokeWidth={3.5} aria-hidden /> : null}
      {status === 'fail' ? <X className="size-2.5" strokeWidth={3.5} aria-hidden /> : null}
      {status === 'you' ? <span className="text-[10px] font-bold leading-none">!</span> : null}
      {status === 'now' ? (
        <span className="size-1.5 rounded-full bg-status-info motion-safe:animate-pulse" />
      ) : null}
    </span>
  )
}

function pullRequestList(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(', ')
}

function milestoneText(milestone: SessionMilestone): { label: string; detail: string | null } {
  switch (milestone.kind) {
    case 'built': {
      const count = milestone.pullRequests.length
      return {
        label: translate('sessionProgress.built', 'Prototype built'),
        detail:
          count === 1
            ? pullRequestList(milestone.pullRequests)
            : milestone.drafts === count
              ? translate('sessionProgress.draftPullRequests', '{{count}} draft PRs', { count })
              : translate('sessionProgress.pullRequests', '{{count}} PRs', { count })
      }
    }
    case 'checks':
      return {
        label: translate('sessionProgress.checks', 'Checks'),
        detail:
          milestone.status === 'fail'
            ? translate('sessionProgress.checksFailing', '{{list}} failing', {
                list: pullRequestList(milestone.pullRequests)
              })
            : translate('sessionProgress.checksRunning', 'running on {{list}}', {
                list: pullRequestList(milestone.pullRequests)
              })
      }
    case 'approved':
      return {
        label: translate('sessionProgress.approved', 'Approved'),
        detail:
          milestone.status === 'you'
            ? translate('sessionProgress.waitingOnYou', 'waiting on you')
            : null
      }
    case 'live':
      return {
        label: translate('sessionProgress.liveOn', 'Live on {{target}}', {
          target: milestone.target
        }),
        detail: liveDetail(milestone)
      }
    case 'merged':
      return { label: translate('sessionProgress.merged', 'Merged'), detail: null }
  }
}

function liveDetail(milestone: Extract<SessionMilestone, { kind: 'live' }>): string | null {
  if (milestone.status === 'fail') {
    return translate('sessionProgress.deployFailed', 'deploy failed')
  }
  if (milestone.status === 'now') {
    return milestone.live > 0
      ? translate('sessionProgress.someLive', '{{live}} of {{total}} live', {
          live: milestone.live,
          total: milestone.total
        })
      : translate('sessionProgress.deploying', 'deploying')
  }
  return null
}

/** "Live on BetaCorp · deploying": a milestone as one line of text. */
export function milestoneSentence(milestone: SessionMilestone): string {
  const { label, detail } = milestoneText(milestone)
  return detail ? `${label} · ${detail}` : label
}

/** Where a goal stands in a few words, for the conversation header and a row's hover. */
export function goalHeadline(group: SessionGoalGroup): {
  text: string
  status: SessionMilestoneStatus
} {
  const next = group.milestones.find((milestone) => milestone.status !== 'done')
  if (!next) {
    const targets = group.milestones.flatMap((milestone) =>
      milestone.kind === 'live' ? [milestone.target] : []
    )
    return {
      text:
        targets.length > 0
          ? translate('sessionProgress.liveOnAll', 'Live on {{targets}}', {
              targets: targets.join(' & ')
            })
          : translate('sessionProgress.allDone', 'Done'),
      status: 'done'
    }
  }
  if (next.status !== 'todo') {
    return { text: milestoneSentence(next), status: next.status }
  }
  return {
    text:
      next.kind === 'approved'
        ? translate('sessionProgress.nextApproval', 'Next: your approval')
        : translate('sessionProgress.nextStep', 'Next: {{step}}', {
            step: milestoneText(next).label
          }),
    status: 'todo'
  }
}

/** The milestone checklist: one row each, mark · label · a few muted words. */
export function SessionProgressRows({
  milestones,
  onApprove
}: {
  milestones: readonly SessionMilestone[]
  /** Offered on an Approved row that is not done; the person's own yes. */
  onApprove?: () => void
}): React.JSX.Element {
  return (
    <ol className="space-y-1" data-session-progress="">
      {milestones.map((milestone) => {
        const { label, detail } = milestoneText(milestone)
        return (
          <li
            key={milestone.key}
            className="flex min-w-0 items-center gap-2"
            data-session-milestone={milestone.kind}
            data-session-milestone-status={milestone.status}
          >
            <MilestoneMark status={milestone.status} />
            <span className="shrink-0 font-medium">{label}</span>
            {detail ? (
              <span
                className={cn(
                  'min-w-0 truncate',
                  milestone.status === 'fail'
                    ? 'text-destructive'
                    : milestone.status === 'you'
                      ? 'text-status-warning'
                      : 'text-muted-foreground'
                )}
                title={detail}
              >
                {detail}
              </span>
            ) : null}
            {onApprove && milestone.kind === 'approved' && milestone.status !== 'done' ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="ml-auto h-5 shrink-0 px-1.5 text-[11px]"
                data-session-approve=""
                onClick={onApprove}
              >
                {translate('sessionProgress.approve', 'Approve')}
              </Button>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/** An earlier goal, folded to one line: its mark, name and where it ended; opens to its rows. */
function EarlierGoal({ group }: { group: SessionGoalGroup }): React.JSX.Element {
  const headline = goalHeadline(group)
  return (
    <details data-session-goal={group.done ? 'done' : 'open'}>
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <MilestoneMark status={group.done ? 'done' : 'todo'} />
        <span className="min-w-0 truncate font-medium" title={group.title}>
          {group.title}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{headline.text}</span>
      </summary>
      <div className="mt-1 pl-6">
        <SessionProgressRows milestones={group.milestones} />
      </div>
    </details>
  )
}

/**
 * The session's goals: earlier ones folded to a line each (✓ when finished), then the current
 * goal's milestones. A single goal shows its milestones alone, under the Goal row.
 */
export function SessionGoalProgress({
  groups,
  onApprove
}: {
  groups: readonly SessionGoalGroup[]
  onApprove?: (group: SessionGoalGroup) => void
}): React.JSX.Element | null {
  const current = groups.at(-1)
  if (!current) {
    return null
  }
  const approve = onApprove ? () => onApprove(current) : undefined
  if (groups.length === 1) {
    return <SessionProgressRows milestones={current.milestones} onApprove={approve} />
  }
  return (
    <div className="space-y-1.5" data-session-goals={groups.length}>
      {groups.slice(0, -1).map((group) => (
        <EarlierGoal key={group.key} group={group} />
      ))}
      <div data-session-goal="current">
        <p className="flex min-w-0 items-center gap-2 font-medium">
          <MilestoneMark status={current.done ? 'done' : 'now'} />
          <span className="min-w-0 truncate" title={current.title}>
            {current.title}
          </span>
        </p>
        <div className="mt-1 pl-6">
          <SessionProgressRows milestones={current.milestones} onApprove={approve} />
        </div>
      </div>
    </div>
  )
}
