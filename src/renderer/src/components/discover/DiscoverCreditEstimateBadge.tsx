import { translate } from '@/i18n/i18n'
import { useId, useState } from 'react'
import { AlertTriangle, Coins, Loader2 } from 'lucide-react'
import type {
  DiscoverCreditBudgetGuard,
  DiscoverCreditQuote
} from '../../../../shared/omnirogue-account'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type DiscoverCreditEstimateBadgeProps = {
  quote: DiscoverCreditQuote | null
  guard: DiscoverCreditBudgetGuard | null
  loading?: boolean
  className?: string
  onTopUpCredits: () => void | Promise<void>
  onConnectOmniRogue: () => void | Promise<void>
  onSwitchToQuick?: () => void | Promise<void>
}

export function DiscoverCreditEstimateBadge({
  quote,
  guard,
  loading = false,
  className,
  onTopUpCredits,
  onConnectOmniRogue,
  onSwitchToQuick
}: DiscoverCreditEstimateBadgeProps) {
  const warningId = useId()
  const [pending, setPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const unavailable =
    !quote ||
    !Number.isFinite(quote.estimatedCredits) ||
    !Number.isFinite(quote.maxReservationCredits) ||
    quote.estimatedCredits < 0 ||
    quote.maxReservationCredits < quote.estimatedCredits
  // A guard without a quote is the unpriced wallet check: its own words say what to do.
  const warning = loading
    ? null
    : unavailable
      ? (guard?.warningMessage ?? 'Credit estimate unavailable. Refresh before launching.')
      : (guard?.warningMessage ??
        (!guard ? 'Check your spendable credits before launching.' : null))

  async function runAction(label: string, action: () => void | Promise<void>) {
    if (pending) {
      return
    }
    setPending(label)
    setActionError(null)
    try {
      await action()
    } catch {
      setActionError(`Could not ${label.toLowerCase()}. Try again.`)
    } finally {
      setPending(null)
    }
  }

  const disabled = loading || pending !== null
  const connect = guard?.recommendedAction === 'connect-account'
  return (
    <div className={cn('inline-flex flex-col gap-2', className)} aria-busy={disabled}>
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge variant="outline" aria-describedby={warning ? warningId : undefined}>
          {loading ? (
            <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <Coins aria-hidden="true" />
          )}
          {loading
            ? translate('discoverCredits.estimating', 'Estimating credits…')
            : unavailable
              ? guard
                ? translate('discoverCredits.noEstimate', 'No credit estimate')
                : translate('discoverCredits.unavailable', 'Credits unavailable')
              : translate('discoverCredits.estimate', 'Est. {{credits}} credits', {
                  credits: quote.estimatedCredits.toLocaleString('en-US')
                })}
        </Badge>
        {!loading && !unavailable && (
          <span className="text-xs text-muted-foreground">
            {translate('discoverCredits.maxReservation', 'Max reservation: {{credits}} credits', {
              credits: quote.maxReservationCredits.toLocaleString('en-US')
            })}
          </span>
        )}
      </div>
      {warning && (
        <div
          id={warningId}
          role="alert"
          className="rounded-md border border-status-warning-border bg-status-warning-background p-2 text-xs text-status-warning"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{warning}</span>
          </div>
          {guard && !guard.allowed && (
            <div className="mt-2 flex flex-wrap gap-2">
              {guard.recommendedAction === 'switch-to-quick' && onSwitchToQuick && (
                <Button
                  type="button"
                  size="xs"
                  disabled={disabled}
                  onClick={() => void runAction('Switch to Quick', onSwitchToQuick)}
                >
                  {translate('discoverCredits.switchToQuick', 'Switch to Quick')}
                </Button>
              )}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void runAction(
                    connect ? 'Connect OmniRogue' : 'Top Up Credits',
                    connect ? onConnectOmniRogue : onTopUpCredits
                  )
                }
              >
                {connect
                  ? translate('omnirogueCredits.connect', 'Connect OmniRogue')
                  : translate('omnirogueCredits.topUp', 'Top Up Credits')}
              </Button>
            </div>
          )}
        </div>
      )}
      {pending && (
        <span role="status" className="text-xs text-muted-foreground">
          {pending}…
        </span>
      )}
      {actionError && (
        <span role="alert" className="text-xs text-destructive">
          {actionError}
        </span>
      )}
    </div>
  )
}
