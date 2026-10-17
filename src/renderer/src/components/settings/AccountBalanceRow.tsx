import { getAccountBalance } from '../../../../shared/account-balance'
import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { Button } from '../ui/button'
import { AccountBalanceActions } from './AccountBalanceActions'
import { AccountBalanceCell } from './AccountBalanceCell'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function AccountBalanceRow({
  provider,
  model,
  account,
  limits,
  defaultId,
  select,
  signIn
}: {
  provider: 'claude' | 'codex'
  model: AccountsPaneSectionModel
  account:
    | AccountsPaneSectionModel['visibleClaudeAccounts'][number]
    | AccountsPaneSectionModel['visibleCodexAccounts'][number]
  limits: ProviderRateLimits | null | undefined
  defaultId: string | null
  select: (id: string | null) => void
  signIn: () => void
}): React.JSX.Element {
  const title = provider === 'claude' ? 'Claude' : 'Codex'
  const action = provider === 'claude' ? model.claudeAction : model.codexAction
  const unavailable = model.accountRuntimeUnavailable || action !== 'idle'
  const canAdd = !unavailable
  return (
    <div key={account.id} className="flex flex-wrap items-center gap-3 px-3 py-2" role="listitem">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={account.email}>
          {account.email}
        </div>
        <div className="text-xs text-muted-foreground">
          {limits?.planType ?? title} · {model.accountRuntime.label}
        </div>
      </div>
      <AccountBalanceCell limits={limits} />
      {getAccountBalance(limits).state === 'needs-login' ? (
        <Button variant="link" size="xs" disabled={!canAdd} onClick={signIn}>
          {translate('settings.providerLogin.signIn', 'Sign in')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="xs"
        disabled={unavailable || account.id === defaultId}
        onClick={() => select(account.id)}
      >
        {account.id === defaultId
          ? translate('settings.accountBalances.default', 'Default')
          : translate('settings.accountBalances.makeDefault', 'Make default')}
      </Button>
      <AccountBalanceActions provider={provider} model={model} account={account} signIn={signIn} />
    </div>
  )
}
