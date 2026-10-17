import { translate } from '@/i18n/i18n'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { Button } from '@/components/ui/button'
import { approveSessionOutcomeReview, verifySessionOutcome } from './next-step-outcome-client'
import { OutcomeResumeAction } from './OutcomeResumeAction'

export function OutcomeResolutionActions({
  chain,
  onChanged,
  onError
}: {
  chain: SessionChain
  onChanged: (chain: SessionChain) => void
  onError: (error: string) => void
}): React.JSX.Element | null {
  const set = chain.outcomeSet
  if (!set) {
    return null
  }
  const unresolved = set.outcomes.flatMap((outcome) =>
    outcome.conditions
      .filter(
        (condition) => !outcome.evidence.some((evidence) => evidence.conditionId === condition.id)
      )
      .map((condition) => ({ outcome, condition }))
  )
  if (!unresolved.length) {
    return <OutcomeResumeAction chain={chain} onChanged={onChanged} onError={onError} />
  }
  const resolve = async (
    outcomeId: string,
    conditionId: string,
    reviewVersion?: string
  ): Promise<void> => {
    try {
      const next = reviewVersion
        ? await approveSessionOutcomeReview({
            id: chain.id,
            owner: chain,
            expectedRevision: set.revision,
            outcomeId,
            conditionId,
            version: reviewVersion
          })
        : await verifySessionOutcome({
            id: chain.id,
            owner: chain,
            expectedRevision: set.revision,
            outcomeId,
            conditionId
          })
      onChanged(next)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className="space-y-2 border-t border-border pt-3" data-next-step-outcome-resolution>
      <OutcomeResumeAction chain={chain} onChanged={onChanged} onError={onError} />
      {unresolved.map(({ outcome, condition }) => (
        <div key={condition.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate">{outcome.title}</span>
          {condition.kind === 'review' ? (
            condition.version ? (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => void resolve(outcome.id, condition.id, condition.version)}
              >
                {translate('nextStep.approveReview', 'Approve review')}
              </Button>
            ) : (
              <span className="text-muted-foreground">
                {translate(
                  'nextStep.resultVersionPreparing',
                  'Current result version is still being prepared.'
                )}
              </span>
            )
          ) : (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => void resolve(outcome.id, condition.id)}
            >
              {translate('nextStep.retryVerification', 'Retry verification')}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
