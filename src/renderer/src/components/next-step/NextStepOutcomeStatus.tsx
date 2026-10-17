import { useState } from 'react'
import { Check, Circle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../../../shared/session-outcome-types'
import { OutcomeResolutionActions } from './OutcomeResolutionActions'
import { NextStepOutcomeDependencyLines } from './NextStepOutcomeDependencyLines'
import { NextStepReviewRounds } from './NextStepReviewRounds'
import {
  nextStepSessionPhase,
  outcomeVerification,
  type NextStepSessionPhase
} from './next-step-outcome-status'
import { useNextStepSessionPhaseInput } from './use-next-step-session-phase'

export function phaseLabel(phase: NextStepSessionPhase, wake?: string): string {
  switch (phase) {
    case 'complete':
      return translate('nextStep.phaseComplete', 'Complete')
    case 'needs-you':
      return translate('nextStep.needsYou', 'Needs you')
    case 'failed':
      return translate('nextStep.phaseFailed', 'Failed')
    case 'recovering':
      return translate('nextStep.phaseRecovering', 'Recovering automatically')
    case 'returned':
      return translate('nextStep.phaseReturned', 'Back to you')
    case 'waiting':
      return wake
        ? translate('nextStep.phaseWaitingFor', 'Waiting for {{wake}}', { wake })
        : translate('nextStep.phaseWaiting', 'Waiting on the agents')
    case 'working':
      return translate('nextStep.phaseWorking', 'Working')
    case 'done':
      return translate('nextStep.phaseDone', 'Done')
    case 'idle':
      return translate('nextStep.phaseIdle', 'Idle')
  }
}

function conditionKindLabel(kind: SessionOutcomeCondition['kind']): string {
  switch (kind) {
    case 'file':
      return translate('nextStep.conditionFile', 'File')
    case 'review':
      return translate('nextStep.conditionReview', 'Review')
    case 'handoff':
      return translate('nextStep.conditionHandoff', 'Handoff')
    case 'pr':
      return translate('nextStep.conditionPr', 'Pull request')
    case 'merge':
      return translate('nextStep.conditionMerge', 'Merge')
    case 'deployment':
      return translate('nextStep.conditionDeployment', 'Deployment')
    case 'command':
      return translate('nextStep.conditionCommand', 'Command')
    case 'report':
      return translate('nextStep.conditionReport', 'Report')
    case 'session':
      return translate('nextStep.conditionSession', 'Source session completion')
    case 'event':
      return translate('nextStep.conditionEvent', 'Wait')
  }
}

/**
 * Where the session stands, in one line: the phase the app already knows, and — once a chain
 * carries saved outcomes — how many of their conditions the host has verified, expandable to
 * the list with the existing approve/retry actions for the ones still open.
 */
export function NextStepOutcomeStatus({
  session,
  outcome,
  chain,
  onChainChanged,
  onError
}: {
  session: SidebarSession
  outcome: NextStepOutcomeDraft
  chain: SessionChain | null
  onChainChanged: (chain: SessionChain) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const input = useNextStepSessionPhaseInput(session)
  const { phase, reason, diagnostic, wake } = nextStepSessionPhase({ ...input, outcome, chain })
  const verification = outcomeVerification(chain)
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1 text-xs" data-next-step-status={phase}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* A stop's raw reason is a diagnostic: it rides in the tooltip, never beside the phase. */}
        <span
          className={cn(
            phase === 'needs-you' || phase === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground',
            'min-w-0 truncate'
          )}
          title={reason ?? diagnostic ?? undefined}
        >
          {phaseLabel(phase, wake)}
          {reason ? ` · ${reason}` : ''}
        </span>
        {verification ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 gap-1 px-1.5"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {translate('nextStep.verifiedCount', '{{verified}}/{{total}} verified', {
              verified: verification.verified,
              total: verification.total
            })}
            <Info className="size-3" />
          </Button>
        ) : null}
      </div>
      <NextStepOutcomeDependencyLines outcomeSet={chain?.outcomeSet} />
      <NextStepReviewRounds chain={chain} />
      {verification && open ? (
        <div className="space-y-2 rounded-md border border-border/60 p-2">
          <ul className="space-y-1">
            {verification.items.map((item) => (
              <li
                key={`${item.outcomeId}:${item.conditionId}`}
                className="flex items-center gap-2"
                data-next-step-condition={item.verified ? 'verified' : 'pending'}
              >
                {item.verified ? (
                  <Check className="size-3 shrink-0" aria-hidden />
                ) : (
                  <Circle className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate" title={item.target}>
                  {item.outcomeTitle} · {conditionKindLabel(item.kind)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {item.verified
                    ? translate('nextStep.conditionVerified', 'verified')
                    : translate('nextStep.conditionPending', 'pending')}
                </span>
              </li>
            ))}
          </ul>
          {chain ? (
            <OutcomeResolutionActions chain={chain} onChanged={onChainChanged} onError={onError} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
