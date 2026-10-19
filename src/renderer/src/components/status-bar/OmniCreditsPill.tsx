import { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  parseCreditWallet,
  creditsExhaustedSchema,
  type CreditWallet,
  type CreditsExhausted
} from '../../../../shared/omni-credits'
import { formatOmniCreditsDate, OmniCreditsUpgradeDialog } from './OmniCreditsUpgradeDialog'

export function OmniCreditsPill({
  iconOnly = false
}: {
  iconOnly?: boolean
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.experimentalOmniCredits === true)
  const api = window.api?.omniCredits
  const [wallet, setWallet] = useState<CreditWallet | null>(null)
  const [prompt, setPrompt] = useState<{
    event: CreditsExhausted
    acknowledge: () => void
  } | null>(null)
  const event = prompt?.event ?? null
  useEffect(() => {
    if (enabled && api) {
      prompt?.acknowledge()
    }
  }, [enabled, api, prompt])

  useEffect(() => {
    setWallet(null)
    setPrompt(null)
    if (!enabled || !api) {
      return
    }
    let disposed = false
    let revision = 0
    let latest: CreditWallet | null = null
    let knownPeriod = ''
    const shown = new Set<string>()
    const pending = new Map<string, string>()
    const reconcile = (period?: string) => {
      if (period) {
        if (shown.delete('')) {
          shown.add(period)
        }
        for (const [id, pendingPeriod] of pending) {
          if (!pendingPeriod) {
            pending.set(id, period)
          }
        }
        knownPeriod = period
      }
      return period || knownPeriod
    }
    const finish = (id: string, displayed: boolean) => {
      void api.finishUpgrade?.(id, displayed).catch(() => {})
    }
    const show = async (exhausted: CreditsExhausted) => {
      const period = reconcile(exhausted.period_end)
      if (shown.has(period) || [...pending.values()].includes(period)) {
        return
      }
      const currentRevision = revision
      const id = window.crypto.randomUUID()
      pending.set(id, period)
      try {
        const claimed = await api.claimUpgrade(period, id)
        if (!disposed && currentRevision === revision && claimed) {
          setPrompt({
            event: {
              ...exhausted,
              period_end: period || undefined,
              plan: exhausted.plan ?? latest?.plan
            },
            acknowledge: () => {
              if (!disposed && currentRevision === revision && pending.has(id)) {
                shown.add(reconcile(period))
                pending.delete(id)
                finish(id, true)
              }
            }
          })
        } else {
          pending.delete(id)
          if (claimed) {
            finish(id, false)
          }
        }
      } catch {
        pending.delete(id)
        finish(id, false)
      }
    }
    const receive = (raw: CreditWallet | null) => {
      if (disposed) {
        return
      }
      const next = parseCreditWallet(raw)
      latest = next
      reconcile(next?.period?.end)
      setWallet(next)
      if (next) {
        const nextPeriod = next.period?.end ?? ''
        setPrompt((open) =>
          open && (!nextPeriod || !open.event.period_end || open.event.period_end === nextPeriod)
            ? {
                ...open,
                event: {
                  ...open.event,
                  plan: next.plan ?? open.event.plan,
                  upgrade: next.upgrade ?? open.event.upgrade
                }
              }
            : open
        )
      }
      if (!next) {
        revision += 1
        for (const id of pending.keys()) {
          finish(id, false)
        }
        pending.clear()
        shown.clear()
        knownPeriod = ''
        setPrompt(null)
      } else if (next.balance === 0 || next.exhausted) {
        void show({
          error: 'credits_exhausted',
          needed: 1,
          balance: next.balance,
          period_end: next.period?.end,
          upgrade: next.upgrade,
          plan: next.plan
        }).catch(() => {})
      }
    }
    const refresh = () => {
      void api
        .getWallet()
        .then(receive)
        .catch(() => receive(null))
    }
    const unsubscribe = api.onWalletChanged(receive)
    const unsubscribeExhausted = api.onExhausted((raw) => {
      const parsed = creditsExhaustedSchema.safeParse(raw)
      if (!disposed && parsed.success) {
        void show(parsed.data).catch(() => {})
      }
    })
    refresh()
    const interval = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      for (const id of pending.keys()) {
        finish(id, false)
      }
      pending.clear()
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      unsubscribe()
      unsubscribeExhausted()
    }
  }, [enabled, api])

  if (!enabled || !api) {
    return null
  }
  if (!wallet) {
    return event ? <OmniCreditsUpgradeDialog event={event} onClose={() => setPrompt(null)} /> : null
  }
  const label = translate('omniCredits.balance', '{{balance}} credits', {
    balance: wallet.balance.toLocaleString()
  })
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={translate('omniCredits.pillLabel', 'OmniOS team: {{balance}}', {
              balance: label
            })}
            data-testid="omni-credits-pill"
            className="inline-flex h-5 items-center gap-1.5 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Coins className="size-3" />
            {!iconOnly ? label : null}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-80 space-y-3 p-3">
          <p className="text-xs font-semibold">
            {translate('omniCredits.title', 'OmniOS team credits')}
          </p>
          <p className="text-lg font-semibold tabular-nums">{label}</p>
          {wallet.plan?.monthly_credits !== 0 && wallet.plan?.id !== 'free' ? (
            <p className="text-xs text-muted-foreground">
              {translate('omniCredits.refill', 'Refills on {{date}}', {
                date: formatOmniCreditsDate(wallet.period?.end)
              })}
            </p>
          ) : null}
          <p className="text-xs">
            {translate('omniCredits.you', 'You used {{usage}} credits this month', {
              usage: wallet.you?.spent?.toLocaleString() ?? '—'
            })}
          </p>
          {wallet.low ? (
            <p className="text-xs text-status-warning">
              {translate('omniCredits.low', '{{balance}} credits left this month.', {
                balance: wallet.balance.toLocaleString()
              })}
            </p>
          ) : null}
          {wallet.members ? (
            <div className="scrollbar-sleek max-h-60 overflow-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  {translate('omniCredits.teamUsage', 'Team usage this month')}
                </caption>
                <thead>
                  <tr>
                    <th>{translate('omniCredits.member', 'Member')}</th>
                    <th className="text-right">{translate('omniCredits.used', 'Credits used')}</th>
                  </tr>
                </thead>
                <tbody>
                  {wallet.members.map((member, index) => (
                    <tr key={`${member.actor}:${index}`}>
                      <td className="py-1">{member.name || member.email || member.actor}</td>
                      <td className="text-right tabular-nums">
                        {member.spent?.toLocaleString() ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {wallet.upgrade.can_upgrade && wallet.upgrade.next_plan ? (
            <Button
              size="sm"
              disabled={!wallet.upgrade.url}
              onClick={() => {
                void window.api.shell.openUrl(wallet.upgrade.url).catch(() => {})
              }}
            >
              {wallet.upgrade.next_plan.contact
                ? translate('omniCredits.talkToUsShort', 'Talk to us')
                : translate('omniCredits.upgrade', 'Upgrade')}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
      <OmniCreditsUpgradeDialog event={event} onClose={() => setPrompt(null)} />
    </>
  )
}
