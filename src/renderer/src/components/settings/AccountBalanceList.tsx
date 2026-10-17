import { useAccountCapacityRows } from '@/hooks/useAccountCapacityRows'
import { sortCapacityRows } from '@/lib/account-capacity-format'
import { AccountCapacityRow } from './AccountCapacityRow'
import { ProviderLoginDialog } from './ProviderLoginDialog'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { useEffect, useState } from 'react'
import { MoreHorizontal, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { getProviderAccountActiveIdForView } from './provider-account-visibility'

import { AccountBalanceNotices } from './AccountBalanceNotices'
import { AccountBalanceRow } from './AccountBalanceRow'
import { AccountBalanceCell } from './AccountBalanceCell'
import { ImportAccountLoginsDialog } from './ImportAccountLoginsDialog'

type Props = { provider: 'claude' | 'codex'; model: AccountsPaneSectionModel }

export function AccountBalanceList({ provider, model }: Props): React.JSX.Element {
  const localRates = useAppStore((state) => state.rateLimits)
  const localCapacityRows = useAccountCapacityRows(provider)
  const [refreshing, setRefreshing] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [discoveryOwner, setDiscoveryOwner] = useState<string | null>(null)
  const ownerId = model.settings.activeRuntimeEnvironmentId ?? ''
  useEffect(() => {
    if (!ownerId) {
      return
    }
    let disposed = false
    void runtimeEnvironmentSupportsCapability(ownerId, 'accounts.autodiscovery.v1')
      .then((supported) => {
        if (!disposed) {
          setDiscoveryOwner(supported ? ownerId : null)
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [ownerId])
  const [login, setLogin] = useState<{ accountId?: string } | null>(null)

  const state = model.isRemoteAccountScope ? model.accountRateLimits : localRates
  const roster = provider === 'claude' ? model.claudeAccounts : model.codexAccounts
  const accounts = provider === 'claude' ? model.visibleClaudeAccounts : model.visibleCodexAccounts
  const defaultId = getProviderAccountActiveIdForView(roster, model.accountRuntime)
  const action = provider === 'claude' ? model.claudeAction : model.codexAction
  const unavailable = model.accountRuntimeUnavailable || action !== 'idle'
  const title = provider === 'claude' ? 'Claude' : 'Codex'
  const target = {
    runtime: model.accountRuntime.runtime,
    wslDistro: model.accountRuntime.wslDistro ?? null
  }
  const capacityRows =
    target.runtime === 'host'
      ? model.isRemoteAccountScope
        ? state?.accountCapacity?.[provider]
        : localRates.accountCapacity?.[provider] !== undefined
          ? localCapacityRows
          : undefined
      : undefined
  const canAdd = !unavailable
  const limitsFor = (id: string | null): ProviderRateLimits | null | undefined => {
    const rateTarget = state?.[provider === 'claude' ? 'claudeTarget' : 'codexTarget']
    if (
      id === defaultId &&
      rateTarget?.runtime === target.runtime &&
      rateTarget.wslDistro === target.wslDistro
    ) {
      return state?.[provider]
    }
    return state?.[
      provider === 'claude' ? 'inactiveClaudeAccounts' : 'inactiveCodexAccounts'
    ]?.find((entry) => entry.accountId === id)?.rateLimits
  }
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await callRuntimeRpc(getActiveRuntimeTarget(model.settings), 'accounts.list', {
        refreshUsage: true
      })
    } catch {
      toast.error(
        translate(
          'settings.accountBalances.refreshError',
          'Could not refresh {{provider}} usage. Try again shortly.',
          { provider: title }
        )
      )
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => {
    if (model.isRemoteAccountScope) {
      return
    }
    const request =
      provider === 'claude'
        ? window.api.rateLimits.fetchInactiveClaudeAccounts
        : window.api.rateLimits.fetchInactiveCodexAccounts
    void request().catch(() =>
      toast.error(
        translate(
          'settings.accountBalances.refreshError',
          'Could not refresh {{provider}} usage. Try again shortly.',
          { provider: provider === 'claude' ? 'Claude' : 'Codex' }
        )
      )
    )
  }, [provider, model.isRemoteAccountScope, accounts.length])

  const select = (id: string | null): void => {
    if (provider === 'claude') {
      void model.runClaudeAccountAction(`select:${id ?? 'system'}`, () =>
        selectClaudeProviderAccount(model.settings, { accountId: id, ...target })
      )
    } else {
      void model.runCodexAccountAction(`select:${id ?? 'system'}`, () =>
        selectCodexProviderAccount(model.settings, { accountId: id, ...target })
      )
    }
  }
  const add = (): void => setLogin({})
  const loginComplete = (): void => {
    const snapshot = (): Promise<ProviderAccountsSnapshot> =>
      callRuntimeRpc(getActiveRuntimeTarget(model.settings), 'accounts.list', {
        refreshUsage: false
      })
    if (provider === 'claude') {
      void model.runClaudeAccountAction('adding', async () => (await snapshot()).claude)
    } else {
      void model.runCodexAccountAction('adding', async () => (await snapshot()).codex)
    }
  }
  return (
    <section id={`accounts-${provider}`} className="space-y-3 scroll-mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {title}{' '}
          <span className="font-normal text-muted-foreground">
            {translate('settings.accountBalances.count', '{{count}} accounts', {
              count: capacityRows?.length ?? accounts.length
            })}
          </span>
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={refreshing}
            onClick={() => void refresh()}
            aria-label={translate(
              'settings.accountBalances.refreshLabel',
              'Refresh {{provider}} balances',
              { provider: title }
            )}
          >
            <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} />
            {translate('settings.accountBalances.refresh', 'Refresh')}
          </Button>
          <Button variant="outline" size="xs" disabled={!canAdd} onClick={add}>
            {translate('auto.components.settings.AccountsPane.b0e948a4f9', 'Add Account')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'settings.accountBalances.options',
                  '{{provider}} account options',
                  { provider: title }
                )}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canAdd || model.isRemoteAccountScope || target.runtime !== 'host'}
                onSelect={() => setImportOpen(true)}
              >
                {translate('settings.accountBalances.importExisting', 'Import existing logins')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {target.runtime === 'host' && (!model.isRemoteAccountScope || discoveryOwner === ownerId)
          ? translate(
              'settings.accountBalances.automaticDiscovery',
              'Showing accounts on {{computer}}. Signed-in Claude and Codex profiles on this computer are detected automatically.',
              { computer: model.accountRuntimeSentenceLabel }
            )
          : translate('settings.accountBalances.owner', 'Showing accounts on {{computer}}.', {
              computer: model.accountRuntimeSentenceLabel
            })}
      </p>
      {model.remoteAccountScopeNotice}
      {provider === 'codex' ? <AccountBalanceNotices model={model} /> : null}
      <div
        className="divide-y divide-border rounded-md border border-border"
        role="list"
        aria-label={translate('settings.accountBalances.listLabel', '{{provider}} accounts', {
          provider: title
        })}
      >
        {capacityRows !== undefined ? (
          sortCapacityRows(capacityRows).map((row) => (
            <AccountCapacityRow
              key={row.choiceId}
              row={row}
              model={model}
              select={select}
              signIn={() => setLogin({ accountId: row.accountId ?? undefined })}
            />
          ))
        ) : (
          <>
            <div className="flex items-center gap-3 px-3 py-2" role="listitem">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {translate('settings.accountBalances.system', 'System login')}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {provider === 'codex'
                    ? (model.systemCodexIdentity?.email ?? model.accountRuntime.label)
                    : model.accountRuntime.label}
                </div>
              </div>
              <AccountBalanceCell limits={limitsFor(null)} />
              <Button
                size="xs"
                variant="ghost"
                disabled={unavailable || defaultId === null}
                onClick={() => select(null)}
              >
                {defaultId === null
                  ? translate('settings.accountBalances.default', 'Default')
                  : translate('settings.accountBalances.makeDefault', 'Make default')}
              </Button>
            </div>
            {accounts.map((account) => (
              <AccountBalanceRow
                key={account.id}
                provider={provider}
                model={model}
                account={account}
                limits={limitsFor(account.id)}
                defaultId={defaultId}
                select={select}
                signIn={() => setLogin({ accountId: account.id })}
              />
            ))}
          </>
        )}
      </div>
      {accounts.length === 0 && canAdd && !model.isRemoteAccountScope ? (
        <Button variant="link" size="xs" onClick={() => setImportOpen(true)}>
          {translate(
            'settings.accountBalances.findLogins',
            'Find my existing {{provider}} logins',
            { provider: title }
          )}
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {target.runtime === 'host'
          ? translate(
              'settings.accountBalances.capacityExplanation',
              'The + button starts new conversations on your default account. Automations use the account with the most room left. Each limit shows what is left in that window.'
            )
          : translate(
              'settings.accountBalances.wslDefault',
              'New WSL sessions use the default account selected for this distribution.'
            )}
      </p>
      {login ? (
        <ProviderLoginDialog
          provider={provider}
          accountId={login.accountId}
          model={model}
          onClose={() => setLogin(null)}
          onComplete={loginComplete}
        />
      ) : null}
      {importOpen ? (
        <ImportAccountLoginsDialog
          provider={provider}
          model={model}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      <p className="sr-only">
        {translate(
          'settings.accountBalances.freshness',
          'Stale readings are excluded from automatic selection.'
        )}
      </p>
    </section>
  )
}
