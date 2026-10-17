import { ChevronDown, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { sessionTeamProgress } from '@/lib/session-team-phases'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { describeSessionChainStrip } from '@/components/next-step/next-step-summary'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import { SessionTeamPhaseRows } from './SessionTeamPhaseRows'
import { useSessionTeam } from './use-session-team'

/**
 * The plan above a conversation, shaped the way it was previewed: which seats run together,
 * which wait, and how far each has come. Reads only what the app already holds — the plan
 * registry and the agent-hook rows — so it costs nothing while nothing changes.
 */
export function SessionTeamPlanStrip({
  session,
  chainId
}: {
  session: SidebarSession
  chainId: string | null
}): React.JSX.Element | null {
  const { team, chain } = useSessionTeam(session, chainId)
  // Why: live helpers alone are not a plan; the strip shows a plan's seats, live helpers beside them.
  const planned = team.members.some(
    (member) => !member.key.startsWith('pane:') && !member.key.startsWith('subagent:')
  )
  if (!chain || !planned) {
    return null
  }
  const progress = sessionTeamProgress(team.members)
  const count =
    progress.planned === progress.total
      ? translate('sessionTeam.plannedCount', '{{count}} agents planned', {
          count: progress.total
        })
      : translate('sessionTeam.doneCount', '{{done}}/{{total}} done', {
          done: progress.done,
          total: progress.total
        })
  const strip = chain
    ? describeSessionChainStrip(chain).join(` ${NEXT_STEP_SHAPE_GLYPH.handoff} `)
    : ''
  return (
    <Collapsible className="shrink-0 border-t" data-session-team-plan={chain?.state ?? 'none'}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group h-auto w-full justify-start rounded-none px-3 py-1.5 text-left"
        >
          <Workflow className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2 text-xs">
              <span>{translate('sessionTeam.title', 'Plan')}</span>
              <span
                className={cn(
                  'shrink-0 font-normal tabular-nums',
                  progress.failed > 0 ? 'text-destructive' : 'text-muted-foreground'
                )}
                data-session-team-count
              >
                {progress.failed > 0
                  ? `${count} · ${translate('sessionTeam.phaseFailed', '{{count}} failed', {
                      count: progress.failed
                    })}`
                  : count}
              </span>
            </span>
            {strip ? (
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {strip}
              </span>
            ) : null}
          </span>
          <ChevronDown
            className="size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="scrollbar-sleek max-h-48 overflow-y-auto px-3 pb-2">
          <SessionTeamPhaseRows members={team.members} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
