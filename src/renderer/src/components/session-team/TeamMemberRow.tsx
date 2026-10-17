import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { AgentIcon } from '@/lib/agent-catalog'
import type { SessionTeamMember } from '@/lib/session-team-summary'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function teamRoleLabel(role: SessionTeamMember['role']): string {
  switch (role) {
    case 'producer':
      return translate('components.sessionHoverCard.roleProducer', 'Producer')
    case 'reviewer':
      return translate('components.sessionHoverCard.roleReviewer', 'Reviewer')
    case 'repair':
      return translate('components.sessionHoverCard.roleRepair', 'Repair')
    case 'subagent':
      return translate('components.sessionHoverCard.roleSubagent', 'Subagent')
    case 'coordinator':
      return translate('components.sessionHoverCard.roleCoordinator', 'Coordinator')
    case 'worker':
      return translate('components.sessionHoverCard.roleWorker', 'Worker')
  }
}

export function teamMemberStateLabel(state: SessionTeamMember['state']): string {
  switch (state) {
    case 'planned':
      return translate('components.sessionHoverCard.statePlanned', 'planned')
    case 'skipped':
      return translate('components.sessionHoverCard.stateSkipped', 'skipped')
    case 'failed':
      return translate('components.sessionHoverCard.stateFailed', 'failed')
    case 'cancelled':
      return translate('components.sessionHoverCard.stateCancelled', 'cancelled')
    // The live states read the same in every language the agent already reports
    // them in, so they pass through — but they are named rather than left to a
    // default, because the lint rule wants every state accounted for and a new
    // one should fail here rather than silently render its raw value.
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
  }
}

/** One seat of the team: who, its role, the exact model and effort, and where it stands. */
export function TeamMemberRow({ member }: { member: SessionTeamMember }): React.JSX.Element {
  const markers = [
    member.group
      ? translate('components.sessionHoverCard.parallelMarker', '∥ {{group}}', {
          group: member.group
        })
      : null,
    member.round
      ? translate('components.sessionHoverCard.roundMarker', 'round {{index}}/{{total}}', {
          index: member.round.index,
          total: member.round.total
        })
      : null,
    member.placement
  ].filter(Boolean)
  return (
    <li className="flex min-w-0 items-center gap-1.5" data-team-member={member.role}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <AgentIcon agent={(member.agent as TuiAgent | null) ?? null} size={12} />
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {teamRoleLabel(member.role)}
        {member.label ? <span className="text-muted-foreground"> · {member.label}</span> : null}
      </span>
      {member.model ? (
        <span className="max-w-24 truncate font-mono text-[10px] text-muted-foreground">
          {member.effort ? `${member.model} · ${member.effort}` : member.model}
        </span>
      ) : null}
      <span
        className={cn(
          'shrink-0 text-[10px]',
          member.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
        )}
        data-team-member-state={member.state}
      >
        {[teamMemberStateLabel(member.state), ...markers].join(' · ')}
      </span>
    </li>
  )
}
