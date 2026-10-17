import { translate } from '@/i18n/i18n'
import type { AccountCapacityRow as CapacityRow } from '../../../../shared/provider-account-capacity'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { AccountBalanceActions } from './AccountBalanceActions'
import { AccountCapacityWindows } from './AccountCapacityWindows'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function AccountCapacityRow({
  row,
  model,
  select,
  signIn
}: {
  row: CapacityRow
  model: AccountsPaneSectionModel
  select: (id: string | null) => void
  signIn: () => void
}): React.JSX.Element {
  const action = row.provider === 'claude' ? model.claudeAction : model.codexAction
  const unavailable = model.accountRuntimeUnavailable || action !== 'idle'
  const systemIdentity = row.isSystem
    ? ((row.provider === 'codex' ? model.systemCodexIdentity?.email : null) ??
      model.accountRuntime.label)
    : null
  const email =
    row.email ??
    systemIdentity ??
    translate('settings.accountBalances.unknownEmail', 'Unknown email')
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2" role="listitem">
      <div className="min-w-0 flex-1">
        {row.isSystem ? (
          <div className="text-xs text-muted-foreground">
            {translate('settings.accountBalances.system', 'System login')}
          </div>
        ) : null}
        <div className="truncate text-sm" title={email}>
          {email}
        </div>
        {row.detail ? <div className="text-xs text-muted-foreground">{row.detail}</div> : null}
        {row.sourceLabel ? (
          <div className="text-xs text-muted-foreground">
            {translate('settings.accountBalances.source', 'via {{source}}', {
              source: row.sourceLabel
            })}
          </div>
        ) : null}
      </div>
      <AccountCapacityWindows row={row} />
      {row.state === 'signed-out' && row.isSystem ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accountBalances.systemSignInHint',
            'Run "{{command}}" in a terminal on {{computer}} to restore the System login.',
            {
              command: row.provider === 'claude' ? 'claude login' : 'codex login',
              computer: model.accountRuntimeSentenceLabel
            }
          )}
        </p>
      ) : null}
      {row.state === 'signed-out' && !row.isSystem ? (
        <Button variant="link" size="xs" disabled={unavailable} onClick={signIn}>
          {translate('settings.providerLogin.signIn', 'Sign in')}
        </Button>
      ) : null}
      {row.isDefault ? (
        <Badge variant="secondary">
          {translate('settings.accountBalances.default', 'Default')}
        </Badge>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          disabled={unavailable || row.state === 'signed-out'}
          title={
            row.state === 'signed-out'
              ? translate(
                  'settings.accountBalances.signInFirst',
                  'Sign in to this account before making it the default'
                )
              : undefined
          }
          onClick={() => select(row.accountId)}
        >
          {translate('settings.accountBalances.makeDefault', 'Make default')}
        </Button>
      )}
      {!row.isSystem && row.accountId !== null ? (
        <AccountBalanceActions
          provider={row.provider}
          model={model}
          account={{ id: row.accountId, email }}
          signIn={signIn}
        />
      ) : null}
    </div>
  )
}
