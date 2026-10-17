import { FolderGit2, Link2, Users, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  PROVIDER_ICON_LABELS,
  ProviderIcon,
  providerIconIdForMcpServer,
  type ProviderIconId
} from '@/lib/provider-icon-catalog'
import type { SessionWorktreeLink } from '@/lib/session-row-details'
import type { SessionTeamSummary } from '@/lib/session-team-summary'
import { TeamMemberRow } from '@/components/session-team/TeamMemberRow'
import { SessionTeamPhaseRows } from '@/components/session-team/SessionTeamPhaseRows'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { SessionCapabilities } from '../../../../../shared/session-capabilities'
import type { SessionCompactContext } from '../../../../../shared/session-compact-context'
import { SessionRowContextSummary } from './SessionRowContextSummary'
import { DetailHeader } from '../WorktreeCardMetadataControls'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from '../WorktreeCardDetailSection'

export type SessionRowHoverCardViewProps = {
  title: string
  context?: SessionCompactContext | null
  agent: string | null
  model: string | null
  stateLabel: string | null
  hostLabel: string | null
  team: SessionTeamSummary
  worktrees: SessionWorktreeLink[]
  capabilities: SessionCapabilities | null
  linkedLine: string | null
  /** The row's status line and details block, when the list keeps them off the row. */
  details?: React.ReactNode
}

function ToolChip({ id, label }: { id: ProviderIconId; label: string }): React.JSX.Element {
  return (
    <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal" title={label}>
      <span className="flex size-3 items-center justify-center text-muted-foreground">
        <ProviderIcon id={id} size={12} />
      </span>
      {label}
    </Badge>
  )
}

function UnknownLine(): React.JSX.Element {
  return (
    <div className="text-muted-foreground" data-capabilities-unknown="">
      {translate(
        'components.sessionHoverCard.capabilitiesUnknown',
        'Unknown · the execution host did not report tools for this session'
      )}
    </div>
  )
}

export function SessionRowHoverCardView(props: SessionRowHoverCardViewProps): React.JSX.Element {
  const { team, worktrees, capabilities } = props
  const providers = capabilities?.providers
  const mcpServers = capabilities?.mcpServers
  const teamSummary = [
    translate('components.sessionHoverCard.teamCount', '{{count}} agents', {
      count: team.members.length
    }),
    team.plannedCount > 0
      ? translate('components.sessionHoverCard.teamPlanned', '{{count}} planned', {
          count: team.plannedCount
        })
      : null,
    team.liveCount > 0
      ? translate('components.sessionHoverCard.teamLive', '{{count}} live', {
          count: team.liveCount
        })
      : null,
    team.parallelGroups > 0
      ? translate('components.sessionHoverCard.teamParallel', '{{count}} parallel groups', {
          count: team.parallelGroups
        })
      : null,
    team.reviewerSeats > 0
      ? translate('components.sessionHoverCard.teamReviewers', '{{count}} reviewer seats', {
          count: team.reviewerSeats
        })
      : null,
    team.maxRounds !== null
      ? translate('components.sessionHoverCard.teamRounds', 'up to {{count}} rounds', {
          count: team.maxRounds
        })
      : null
  ].filter(Boolean)
  return (
    <div className="space-y-3" data-session-hover-card="">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <AgentIcon agent={(props.agent as TuiAgent | null) ?? null} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
            {props.title}
          </div>
          <div className="text-muted-foreground">
            {[props.agent, props.model, props.stateLabel, props.hostLabel]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>

      <SessionRowContextSummary context={props.context} />

      {props.details ? (
        <div className="space-y-1" data-session-hover-details="">
          {props.details}
        </div>
      ) : null}

      {props.linkedLine ? (
        <div
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
          data-session-linked=""
        >
          <Link2 className="size-3 shrink-0" />
          <span className="truncate">{props.linkedLine}</span>
        </div>
      ) : null}

      <WorktreeCardDetailSection>
        <DetailHeader
          icon={<Users className="size-3 text-muted-foreground" />}
          label={translate('components.sessionHoverCard.team', 'Team')}
        />
        <WorktreeCardDetailSectionContent className="space-y-1">
          {team.members.length === 0 ? (
            <div className="text-muted-foreground">
              {translate('components.sessionHoverCard.teamSolo', 'Working alone · no team planned')}
            </div>
          ) : (
            <>
              <div className="text-muted-foreground">{teamSummary.join(' · ')}</div>
              <SessionTeamPhaseRows members={team.members} dense />
              <ul className="space-y-1">
                {team.members.map((member) => (
                  <TeamMemberRow key={member.key} member={member} />
                ))}
              </ul>
            </>
          )}
        </WorktreeCardDetailSectionContent>
      </WorktreeCardDetailSection>

      {worktrees.length > 0 ? (
        <WorktreeCardDetailSection>
          <DetailHeader
            icon={<FolderGit2 className="size-3 text-muted-foreground" />}
            label={translate('components.sessionHoverCard.worktrees', 'Worktrees')}
          />
          <WorktreeCardDetailSectionContent>
            <ul className="space-y-1">
              {worktrees.map((link) => (
                <li key={link.id} className="min-w-0" data-worktree-relation={link.relation}>
                  <div className="truncate text-foreground">
                    {link.name}
                    {link.branch ? (
                      <span className="font-mono text-muted-foreground"> · {link.branch}</span>
                    ) : link.folder ? (
                      <span className="text-muted-foreground">
                        {' · '}
                        {translate('components.sessionHoverCard.folderWorkspace', 'folder')}
                      </span>
                    ) : null}
                  </div>
                  {link.path ? (
                    <div
                      className="truncate font-mono text-[10px] text-muted-foreground"
                      title={link.path}
                    >
                      {link.path}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </WorktreeCardDetailSectionContent>
        </WorktreeCardDetailSection>
      ) : null}

      <WorktreeCardDetailSection>
        <DetailHeader
          icon={<Wrench className="size-3 text-muted-foreground" />}
          label={translate('components.sessionHoverCard.tools', 'Tools & providers')}
        />
        <WorktreeCardDetailSectionContent>
          {!capabilities || providers === 'unknown' || mcpServers === 'unknown' ? (
            <UnknownLine />
          ) : null}
          {Array.isArray(providers) || Array.isArray(mcpServers) ? (
            <div className="flex flex-wrap gap-1">
              {Array.isArray(providers)
                ? providers.map((provider) => (
                    <ToolChip
                      key={`provider:${provider.provider}`}
                      id={provider.provider}
                      label={PROVIDER_ICON_LABELS[provider.provider]}
                    />
                  ))
                : null}
              {Array.isArray(mcpServers)
                ? mcpServers.map((server) => (
                    <ToolChip
                      key={`mcp:${server.name}`}
                      id={providerIconIdForMcpServer(server.name)}
                      label={server.name}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </WorktreeCardDetailSectionContent>
      </WorktreeCardDetailSection>
    </div>
  )
}
