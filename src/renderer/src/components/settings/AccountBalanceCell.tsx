import { translate } from '@/i18n/i18n'
import { getAccountBalance } from '../../../../shared/account-balance'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export function AccountBalanceCell({
  limits
}: {
  limits: ProviderRateLimits | null | undefined
}): React.JSX.Element {
  const balance = getAccountBalance(limits)
  const label =
    balance.state === 'needs-login'
      ? translate('settings.accountBalances.needsLogin', 'Needs sign-in')
      : balance.state === 'rate-limited'
        ? translate('settings.accountBalances.rateLimited', 'Rate limited')
        : balance.remainingPercent === null
          ? translate('settings.accountBalances.unavailable', 'Usage unavailable')
          : balance.state === 'stale'
            ? translate('settings.accountBalances.stale', '{{percent}}% left · stale', {
                percent: Math.round(balance.remainingPercent)
              })
            : translate('settings.accountBalances.remaining', '{{percent}}% left', {
                percent: Math.round(balance.remainingPercent)
              })
  const updated =
    limits?.updatedAt && Number.isFinite(limits.updatedAt)
      ? translate('settings.accountBalances.updated', 'Updated {{time}}', {
          time: new Date(limits.updatedAt).toLocaleString()
        })
      : translate('settings.accountBalances.noReading', 'No usage reading yet')
  return (
    <div
      className="min-w-32 text-right text-xs"
      title={[updated, limits?.error].filter(Boolean).join('\n')}
    >
      <div className="font-medium tabular-nums">{label}</div>
      <div className="text-muted-foreground">
        {balance.resetsAt
          ? translate('settings.accountBalances.resets', 'Resets {{time}}', {
              time: new Date(balance.resetsAt).toLocaleString(undefined, {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit'
              })
            })
          : translate('settings.accountBalances.resetUnknown', 'Reset time unavailable')}
      </div>
      <span className="sr-only">{updated}</span>
    </div>
  )
}
