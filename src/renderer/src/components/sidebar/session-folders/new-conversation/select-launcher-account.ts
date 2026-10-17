import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import {
  createClaudeAccountActionRunner,
  createCodexAccountActionRunner
} from '@/components/settings/accounts-pane-account-actions'
import type { LauncherAccountRow } from './use-launcher-account-rows'

export async function selectLauncherAccount(row: LauncherAccountRow): Promise<void> {
  const state = useAppStore.getState()
  if (!state.settings) {
    return
  }
  // Why: a menu's account stays with the host that supplied it, even if focus changes.
  const ownerSettings = {
    ...state.settings,
    activeRuntimeEnvironmentId: row.runtimeEnvironmentId ?? null
  }
  const snapshot = await fetchProviderAccountsSnapshot(ownerSettings)
  const context = {
    settings: ownerSettings,
    accountRuntime: {
      runtime: 'host' as const,
      label: translate('computerPicker.selectedAccounts', 'Accounts on this computer')
    },
    isRemoteAccountScope: Boolean(row.runtimeEnvironmentId),
    fetchSettings: state.fetchSettings,
    recordFeatureInteraction: state.recordFeatureInteraction
  }
  if (row.provider === 'claude') {
    await createClaudeAccountActionRunner({
      ...context,
      claudeAccounts: snapshot.claude,
      setClaudeAccounts: () => {},
      setClaudeAction: () => {}
    })(`select:${row.accountId ?? 'system'}`, () =>
      selectClaudeProviderAccount(ownerSettings, { accountId: row.accountId, runtime: 'host' })
    )
    return
  }
  await createCodexAccountActionRunner({
    ...context,
    codexAccounts: snapshot.codex,
    setCodexAccounts: () => {},
    setCodexAccountsLoaded: () => {},
    setCodexAction: () => {}
  })(`select:${row.accountId ?? 'system'}`, () =>
    selectCodexProviderAccount(ownerSettings, { accountId: row.accountId, runtime: 'host' })
  )
}
