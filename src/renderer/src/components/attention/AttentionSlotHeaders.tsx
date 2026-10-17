import React from 'react'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { ConversationStateIcon } from '@/components/sidebar/session-folders/ConversationStateIcon'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CompanyPlaceCrumb } from '@/components/companies/CompanyPlaceCrumb'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AttentionPane } from './agent-pane-snapshot'
import {
  attentionCauseLabel,
  attentionPaneTitle,
  describeAttentionAsk
} from './attention-pane-labels'

export function AttentionCurrentHeader({
  label,
  workspaceLabel,
  worktreeId = null,
  agent,
  sessionModel,
  trailing
}: {
  label: string
  workspaceLabel: string
  /** The workspace the session runs in, for its company › department crumb. */
  worktreeId?: string | null
  agent: TuiAgent | null
  /** Model the session reported through its status hook; null until it reports one. */
  sessionModel?: string | null
  /** Compact controls for the session in view, such as its saved next step. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <span className="inline-flex shrink-0 pt-[3px]">
        <AgentIcon agent={agent} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-snug">{label}</div>
        <div className="truncate text-xs text-muted-foreground">
          <CompanyPlaceCrumb worktreeId={worktreeId} className="mr-1 max-w-[50%]" />
          {translate('auto.components.attention.AttentionPage.workingOn', 'Working on')} ·{' '}
          {workspaceLabel}
          {sessionModel ? (
            <span data-attention-session-model={sessionModel}>
              {' · '}
              {translate(
                'attentionLauncher.sessionModel',
                'model {{model}} (reported by the session)',
                {
                  model: sessionModel
                }
              )}
            </span>
          ) : null}
        </div>
      </div>
      {trailing ? <div className="flex shrink-0 items-center pt-px">{trailing}</div> : null}
    </>
  )
}

export function AttentionNeedsYouHeader({
  pane,
  index,
  total,
  held,
  onPrevious,
  onNext,
  onOpenInWorkspace,
  action = null,
  trailing = null
}: {
  pane: AttentionPane
  index: number
  total: number
  held: boolean
  onPrevious: () => void
  onNext: () => void
  onOpenInWorkspace: () => void
  /** The direct way to meet a run's request, when this entry is one. */
  action?: React.ReactNode
  /** ＋ ⏳ ✓ for the pane asking — the place Wait and Done are most needed. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  // Why: a run's request says exactly what is needed; the pane's own prompt text is not it.
  const ask = pane.run ? pane.run.headline : describeAttentionAsk(pane.askSummary)
  const openLabel = translate(
    'auto.components.attention.AttentionPage.openInWorkspace',
    'Open in workspace'
  )
  return (
    <>
      <span className="inline-flex shrink-0 items-start gap-1 pt-[3px]">
        {/* Why: the same glyph the sidebar row shows, so ❗ means one thing everywhere. */}
        <ConversationStateIcon state={held ? 'done' : 'needs-you'} />
        <AgentIcon agent={agentTypeToIconAgent(pane.agentType)} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-snug">
          {attentionPaneTitle(pane)}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <CompanyPlaceCrumb worktreeId={pane.worktreeId} className="mr-1 max-w-[50%]" />
          {pane.repoName} / {pane.worktreeName} ·{' '}
          {held
            ? translate(
                'auto.components.attention.AttentionPage.heldDone',
                'Done — clears when you leave this pane'
              )
            : attentionCauseLabel(pane.cause)}
        </div>
        {ask && !held ? (
          <div
            className="mt-0.5 line-clamp-2 text-xs text-agent-question-text"
            data-attention-ask={pane.run ? 'request' : 'pane'}
          >
            {ask}
          </div>
        ) : null}
        {pane.run?.why && !held ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" data-attention-why="">
            {pane.run.why}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-px">
        {held ? null : action}
        {trailing}
        {total > 1 ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.attention.AttentionPage.previousPane',
                'Previous pane that needs you'
              )}
              onClick={onPrevious}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {translate(
                'auto.components.attention.AttentionPage.indexOfTotal',
                '{{index}} of {{total}}',
                { index: index + 1, total }
              )}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.attention.AttentionPage.nextPane',
                'Next pane that needs you'
              )}
              onClick={onNext}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={openLabel}
              onClick={onOpenInWorkspace}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{openLabel}</TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}
