import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type {
  NextStepHandoffOptions,
  NextStepOutcomeDraft
} from '../../../../shared/next-step-draft'
import { NextStepOutcomeFactsMore, PlaceGlance, TaskGlance } from './NextStepOutcomeFactsMore'
import { NextStepOutcomeFiles } from './NextStepOutcomeFiles'
import { phaseLabel } from './NextStepOutcomeStatus'
import type { NextStepOutcomeFacts as Facts } from './next-step-outcome-facts'
import { nextStepSessionPhase } from './next-step-outcome-status'
import { useNextStepSessionPhaseInput } from './use-next-step-session-phase'

/**
 * What the dialog already knows, in three lines: the session and its phase, the folder the
 * files go to, and the task — or, without one, where the work is filed. Everything else sits
 * behind "More", and each line opens its one editor on hover or click.
 */
export function NextStepOutcomeFacts({
  facts,
  outcome,
  onOutcomeChange,
  handoff,
  onHandoffChange,
  chain,
  onChainChanged,
  onError
}: {
  facts: Facts
  outcome: NextStepOutcomeDraft
  onOutcomeChange: (outcome: NextStepOutcomeDraft) => void
  handoff: NextStepHandoffOptions
  onHandoffChange: (patch: Partial<NextStepHandoffOptions>) => void
  chain: SessionChain | null
  onChainChanged: (chain: SessionChain) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const input = useNextStepSessionPhaseInput(facts.session)
  const { phase, reason, diagnostic, wake } = nextStepSessionPhase({ ...input, outcome, chain })
  const detail = reason ?? diagnostic
  const showsTask = facts.task !== null
  return (
    <section
      className="min-w-0 space-y-2"
      data-next-step-section="details"
      aria-label={translate('nextStep.details', 'Details')}
    >
      <p
        className="min-w-0 truncate text-xs"
        title={detail ? `${facts.session.label} · ${detail}` : facts.session.label}
        data-next-step-status={phase}
      >
        <span className="font-medium">{facts.session.label}</span>
        <span
          className={cn(
            phase === 'needs-you' || phase === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground'
          )}
        >
          {` · ${phaseLabel(phase, wake)}`}
        </span>
      </p>
      <NextStepOutcomeFiles facts={facts} handoff={handoff} onHandoffChange={onHandoffChange} />
      {showsTask ? <TaskGlance facts={facts} /> : <PlaceGlance facts={facts} />}
      <NextStepOutcomeFactsMore
        facts={facts}
        outcome={outcome}
        onOutcomeChange={onOutcomeChange}
        chain={chain}
        onChainChanged={onChainChanged}
        onError={onError}
        showsTask={showsTask}
      />
    </section>
  )
}
