import { useState } from 'react'
import { SessionFollowUpPanel } from '@/components/session-follow-up/SessionFollowUpPanel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import {
  isSessionChainAgentStep,
  isSessionFollowUpChain,
  type SessionChain,
  type SessionChainAgentStep,
  type SessionChainStep
} from '../../../../shared/session-chain-types'
import { isSessionEffortParityDivergent } from '../../../../shared/session-effort-parity'
import { summarizeSessionChainTeam } from '../../../../shared/session-chain-team'
import {
  sessionChainStepRoleLabel,
  sessionChainStepRoundLabel,
  sessionChainTeamHeadline
} from './session-chain-team-labels'
import {
  actionLabel,
  describeSessionChain,
  describeSessionChainStrip,
  nextStepAgentName,
  sessionChainEndingLabel
} from './next-step-summary'

function stepStatus(step: SessionChainStep): string {
  if (step.kind === 'handoff') {
    return step.status === 'delivered'
      ? translate('nextStep.stepSent', 'sent')
      : translate('nextStep.stepQueued', 'queued')
  }
  switch (step.status) {
    case 'launched':
      return translate('nextStep.stepStarted', 'started')
    case 'skipped':
      return translate('nextStep.stepSkipped', 'skipped')
    case 'failed':
      // Why: a step whose agent died used to keep reading "queued" here, which is what made
      // hours of silence look like work still to come.
      return translate('nextStep.stepFailed', 'failed')
    case 'queued':
      return translate('nextStep.stepQueued', 'queued')
  }
}

/**
 * The step's effort, and what its launch actually carried when the two differ. Why not
 * the requested value alone: a step whose effort was dropped or refused read exactly
 * like one that got it.
 */
function stepEffortLabel(step: SessionChainAgentStep): string | null {
  const parity = step.effortParity
  if (!step.effort) {
    return parity?.applied?.effort ?? null
  }
  if (!isSessionEffortParityDivergent(parity)) {
    return step.effort
  }
  return parity?.applied?.effort
    ? translate('nextStep.stepEffortMismatch', '{{value0}} → ran at {{value1}}', {
        value0: step.effort,
        value1: parity.applied.effort
      })
    : translate('nextStep.stepEffortNotApplied', '{{value0}} → not applied', {
        value0: step.effort
      })
}

function stepLine(step: SessionChainStep): string {
  if (!isSessionChainAgentStep(step)) {
    return `${NEXT_STEP_SHAPE_GLYPH.person} ${[...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].map((r) => r.name).join(', ')}`
  }
  const parts = [
    step.role ? sessionChainStepRoleLabel(step.role) : null,
    step.presetId ? actionLabel(step.presetId) : null,
    nextStepAgentName(step.agent),
    step.model ?? null,
    stepEffortLabel(step),
    sessionChainStepRoundLabel(step),
    step.group && !step.review ? NEXT_STEP_SHAPE_GLYPH.parallel : null
  ]
  return parts.filter((part): part is string => !!part).join(' · ')
}

/**
 * What is queued after a session, at a glance: "Current → ✨ Improve · Claude → 👤 Uma →
 * Done". Clicking opens each step; when people are part of it, the saved step's receipt
 * (send now, retry, cancel) is right there — the same panel the queue always had.
 */
export function SessionChainStatus({
  chain,
  session
}: {
  chain: SessionChain
  session: SidebarSession
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const strip = chain.state === 'failed' ? null : describeSessionChainStrip(chain)
  const text = strip
    ? strip.join(` ${NEXT_STEP_SHAPE_GLYPH.handoff} `)
    : describeSessionChain(chain)
  if (!text) {
    return null
  }
  const teamHeadline = open ? sessionChainTeamHeadline(summarizeSessionChainTeam(chain)) : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="max-w-80 gap-1 text-muted-foreground"
          data-session-chain-status
          data-session-follow-up-state={chain.state}
          title={text}
        >
          <span className="truncate">{text}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="scrollbar-sleek max-h-[70vh] w-[min(480px,calc(100vw-1rem))] space-y-3 overflow-y-auto p-3"
      >
        {teamHeadline ? (
          <p className="text-xs text-muted-foreground" data-session-chain-team>
            {teamHeadline}
          </p>
        ) : null}
        <ol className="space-y-1 text-xs" data-session-chain-steps>
          <li className="text-muted-foreground">{translate('nextStep.stripCurrent', 'Current')}</li>
          {chain.steps.map((step, index) => (
            <li key={step.id} className="flex items-center gap-2">
              <span className="text-muted-foreground">{NEXT_STEP_SHAPE_GLYPH.handoff}</span>
              <span className="min-w-0 flex-1 truncate" data-session-chain-step={index}>
                {stepLine(step)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{stepStatus(step)}</span>
            </li>
          ))}
          <li className="text-muted-foreground">
            {NEXT_STEP_SHAPE_GLYPH.handoff} {sessionChainEndingLabel(chain)}
          </li>
        </ol>
        {isSessionFollowUpChain(chain) && open ? <SessionFollowUpPanel session={session} /> : null}
      </PopoverContent>
    </Popover>
  )
}
