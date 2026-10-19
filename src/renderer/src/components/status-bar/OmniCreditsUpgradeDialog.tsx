import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { CreditsExhausted } from '../../../../shared/omni-credits'

export function formatOmniCreditsDate(value?: string): string {
  const date = value ? new Date(value) : null
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { timeZone: 'UTC' })
    : translate('omniCredits.unknownDate', 'Not available')
}

export function upgradeLabel(next: NonNullable<CreditsExhausted['upgrade']['next_plan']>): string {
  if (next.contact) {
    return translate('omniCredits.talkToUs', 'Talk to us about {{plan}}', { plan: next.name })
  }
  if (next.interval === 'once') {
    return translate('omniCredits.upgradeOnce', 'Upgrade to {{plan}} — {{price}} one-time', {
      plan: next.name,
      price: next.setup_price ?? next.price ?? '—'
    })
  }
  if (next.setup_price) {
    return translate(
      'omniCredits.upgradeSetup',
      'Upgrade to {{plan}} — {{setup}} setup + {{price}}/month',
      { plan: next.name, setup: next.setup_price, price: next.price ?? '—' }
    )
  }
  return translate(
    'omniCredits.upgradePlan',
    'Upgrade to {{plan}} — {{price}}/month, {{credits}} credits a month',
    {
      plan: next.name,
      price: next.price ?? '—',
      credits: next.monthly_credits?.toLocaleString() ?? '—'
    }
  )
}

export function OmniCreditsUpgradeDialog({
  event,
  onClose
}: {
  event: CreditsExhausted | null
  onClose: () => void
}): React.JSX.Element {
  const next = event?.upgrade.next_plan
  // No monthly credits with a plan to move to = Free; with nothing to move to = Enterprise,
  // whose credits come with its agreement.
  const noMonthly = event?.plan?.monthly_credits === 0
  const free = event?.plan?.id === 'free' || (noMonthly && !!next)
  const agreement = !free && noMonthly && !next
  return (
    <Dialog
      open={event !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {free
              ? translate('omniCredits.freeTitle', 'Choose a plan to keep going')
              : translate('omniCredits.exhaustedTitle', "You're out of credits")}
          </DialogTitle>
          <DialogDescription>
            {free
              ? translate(
                  'omniCredits.freeBody',
                  'Your team has no credits on the Free plan. Pick a plan to make images, videos and reviews.'
                )
              : agreement
                ? translate(
                    'omniCredits.agreementBody',
                    'This needs {{needed}} credits and you have {{balance}}.',
                    { needed: event?.needed ?? '—', balance: event?.balance ?? '—' }
                  )
                : translate(
                    'omniCredits.exhaustedBody',
                    'This needs {{needed}} credits and you have {{balance}}. Your credits refill on {{date}}.',
                    {
                      needed: event?.needed ?? '—',
                      balance: event?.balance ?? '—',
                      date: formatOmniCreditsDate(event?.period_end)
                    }
                  )}
          </DialogDescription>
        </DialogHeader>
        {!event?.upgrade.can_upgrade ? (
          <p className="text-sm">
            {translate('omniCredits.askAdmin', 'Ask an admin on your team to upgrade.')}
          </p>
        ) : agreement ? (
          <p className="text-sm">
            {translate(
              'omniCredits.agreementContact',
              'Contact us to add credits to your agreement.'
            )}
          </p>
        ) : !next && !free ? (
          <p className="text-sm">
            {translate(
              'omniCredits.topPlan',
              'Your credits refill on {{date}}. Need more sooner? Contact us.',
              { date: formatOmniCreditsDate(event?.period_end) }
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('omniCredits.notNow', 'Not now')}
          </Button>
          {event?.upgrade.can_upgrade && next ? (
            <Button
              disabled={!event.upgrade.url}
              onClick={() => {
                void window.api.shell.openUrl(event.upgrade.url).catch(() => {})
              }}
            >
              {free ? translate('omniCredits.choosePlan', 'Choose a plan') : upgradeLabel(next)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
