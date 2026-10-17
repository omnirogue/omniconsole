import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  summarizeSessionReviewRounds,
  type SessionReviewerVerdictStatus
} from '../../../../shared/session-review-rounds'
import { sessionOutcomeHostRouteReason } from '../../../../shared/session-outcome-host-route'

function verdictLabel(status: SessionReviewerVerdictStatus): string {
  switch (status) {
    case 'pass':
      return translate('nextStep.reviewVerdictPass', 'Approved')
    case 'findings':
      return translate('nextStep.reviewVerdictFindings', 'Changes requested')
    case 'running':
      return translate('nextStep.reviewVerdictRunning', 'Reviewing…')
    case 'blocked':
      return translate('nextStep.reviewVerdictBlocked', 'Could not start')
    case 'failed':
      return translate('nextStep.reviewVerdictFailed', 'Could not review')
    case 'unverifiable':
      return translate('nextStep.reviewVerdictUnverifiable', 'Unverifiable')
    case 'pending':
      return translate('nextStep.reviewVerdictPending', 'Waiting')
  }
}

const ALARMING: SessionReviewerVerdictStatus[] = ['findings', 'blocked', 'failed']

/** Every review round of the saved plan, each reviewer's verdict, evidence and blocking findings. */
export function NextStepReviewRounds({
  chain
}: {
  chain: Pick<SessionChain, 'steps' | 'reviewLoop' | 'outcomeSet'> | null
}): React.JSX.Element | null {
  const rounds = summarizeSessionReviewRounds(chain)
  const hostReason = chain ? sessionOutcomeHostRouteReason(chain) : null
  if (!rounds.length) {
    return null
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2" data-next-step-review-rounds>
      {hostReason ? <p className="text-muted-foreground">{hostReason}</p> : null}
      {rounds.map((round) => (
        <section
          key={`${round.generationId}:${round.groupId}:${round.round}`}
          className="space-y-1"
          data-next-step-review-generation={round.generationId}
        >
          <p className="font-medium">
            {translate('nextStep.reviewRound', 'Review round {{round}}', { round: round.round })}
            {round.superseded ? (
              <span className="ml-2 font-normal text-muted-foreground">
                {translate('nextStep.reviewRoundSuperseded', 'Earlier plan')}
              </span>
            ) : null}
          </p>
          <ul className="space-y-1">
            {round.reviewers.map((reviewer) => (
              <li
                key={reviewer.reviewerId}
                className="space-y-0.5"
                data-next-step-reviewer-verdict={reviewer.status}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {[reviewer.agent, reviewer.model].filter(Boolean).join(' · ')}
                  </span>
                  <span
                    className={cn(
                      'shrink-0',
                      ALARMING.includes(reviewer.status)
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    )}
                  >
                    {verdictLabel(reviewer.status)}
                  </span>
                </div>
                {reviewer.notes ? <p className="text-muted-foreground">{reviewer.notes}</p> : null}
                {reviewer.blockingFindings.length ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                    {reviewer.blockingFindings.map((finding) => (
                      <li key={finding}>{finding}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
