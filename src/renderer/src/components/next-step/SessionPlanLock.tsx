import { CircleCheck, Lock, UserRound } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SessionChainRowInfo } from '@/lib/session-chain-support'

/** What the 🔒 and its destination glyph say: the next step is set, and where the work ends up. */
export function sessionPlanLockLabel(destination: SessionChainRowInfo['destination']): string {
  switch (destination.kind) {
    case 'done':
      return translate(
        'nextStep.planEndsSession',
        'Next step is set · the session ends when it finishes successfully'
      )
    case 'person':
      return translate('nextStep.planEndsWithPerson', 'Next step is set · then goes to {{name}}', {
        name: destination.names
      })
    case 'me':
      return translate('nextStep.planEndsWithMe', 'Next step is set · then comes back to you')
  }
}

/**
 * Replaces ＋ once a next step is chosen: a lock, and where the work goes when the plan is
 * through — a green ✓ when the session ends, a person when someone gets it.
 */
export function SessionPlanLock({ chain }: { chain: SessionChainRowInfo }): React.JSX.Element {
  const label = sessionPlanLockLabel(chain.destination)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center gap-0.5 px-1 text-muted-foreground"
          role="img"
          aria-label={label}
          data-session-plan-lock={chain.destination.kind}
        >
          <Lock className="size-3.5" aria-hidden />
          {chain.destination.kind === 'done' ? (
            <CircleCheck className="size-3.5 text-emerald-500" aria-hidden />
          ) : (
            <UserRound className="size-3.5" aria-hidden />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        <p>{label}</p>
        {chain.summary ? <p className="text-muted-foreground">{chain.summary}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
}
