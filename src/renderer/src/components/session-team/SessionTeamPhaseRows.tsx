import { AgentStateDot } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  sessionTeamMemberDot,
  sessionTeamPhases,
  sessionTeamProgress,
  type SessionTeamPhase
} from '@/lib/session-team-phases'
import type { SessionTeamMember } from '@/lib/session-team-summary'
import { actionLabel, nextStepAgentName } from '@/components/next-step/next-step-summary'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { teamMemberStateLabel, teamRoleLabel } from './TeamMemberRow'

function phaseTitle(phase: SessionTeamPhase): string {
  if (phase.action) {
    return actionLabel(phase.action)
  }
  switch (phase.kind) {
    case 'review':
      return translate('sessionTeam.phaseReview', '👀 Review')
    case 'repair':
      return translate('sessionTeam.phaseRepair', '🛠 Repair')
    case 'workers':
      return translate('sessionTeam.phaseWorkers', 'Dispatched workers')
    case 'subagents':
      return translate('sessionTeam.phaseSubagents', 'Subagents')
    case 'work':
      return teamRoleLabel(phase.members[0]!.role)
  }
}

/** "Claude · opus · high · working" for the dot's tooltip. */
function memberTitle(member: SessionTeamMember): string {
  const who = member.agent
    ? nextStepAgentName(member.agent as TuiAgent)
    : teamRoleLabel(member.role)
  return [who, member.model, member.effort, teamMemberStateLabel(member.state), member.label]
    .filter(Boolean)
    .join(' · ')
}

function phaseShape(phase: SessionTeamPhase): string {
  if (phase.parallel) {
    return translate('sessionTeam.phaseParallel', '{{glyph}} {{count}} together', {
      glyph: NEXT_STEP_SHAPE_GLYPH.parallel,
      count: phase.members.length
    })
  }
  if (phase.round) {
    return `${NEXT_STEP_SHAPE_GLYPH.rounds} ${phase.round.index}/${phase.round.total}`
  }
  return ''
}

/**
 * The plan as rows: one row per phase, a state glyph per seat, the models beneath. Seats
 * that launch together share a row; what waits on them is the next row down. Before Go
 * every glyph is the quiet dot; after Go the same glyphs fill in.
 */
export function SessionTeamPhaseRows({
  members,
  dense = false
}: {
  members: readonly SessionTeamMember[]
  /** One line per phase, no model line: for hover cards and narrow columns. */
  dense?: boolean
}): React.JSX.Element | null {
  const phases = sessionTeamPhases(members)
  if (phases.length === 0) {
    return null
  }
  return (
    <ol className="space-y-1 text-xs" data-session-team-phases={phases.length}>
      {phases.map((phase, index) => {
        const progress = sessionTeamProgress(phase.members)
        return (
          <li key={phase.key} className="min-w-0" data-session-team-phase={phase.kind}>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="flex shrink-0 items-center gap-0.5" data-session-team-dots>
                {phase.members.map((member) => (
                  // Why a native title: the glyph shows in hover cards and popovers that carry no
                  // tooltip provider, and the label must read the same everywhere it appears.
                  <span
                    key={member.key}
                    title={memberTitle(member)}
                    data-session-team-seat={member.state}
                  >
                    <AgentStateDot state={sessionTeamMemberDot(member.state)} title={null} />
                  </span>
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {phaseTitle(phase)}
                {phaseShape(phase) ? (
                  <span className="text-muted-foreground"> · {phaseShape(phase)}</span>
                ) : null}
              </span>
              <span
                className={cn(
                  'shrink-0 tabular-nums',
                  progress.failed > 0 ? 'text-destructive' : 'text-muted-foreground'
                )}
                data-session-team-phase-progress={`${progress.done}/${progress.total}`}
              >
                {progress.failed > 0
                  ? translate('sessionTeam.phaseFailed', '{{count}} failed', {
                      count: progress.failed
                    })
                  : progress.planned === progress.total
                    ? ''
                    : `${progress.done}/${progress.total}`}
              </span>
            </div>
            {dense ? null : (
              <p className="truncate pl-5.5 font-mono text-[10px] text-muted-foreground">
                {phase.members
                  .map((member) =>
                    [
                      member.agent ? nextStepAgentName(member.agent as TuiAgent) : null,
                      member.model,
                      member.effort
                    ]
                      .filter(Boolean)
                      .join(' ')
                  )
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
