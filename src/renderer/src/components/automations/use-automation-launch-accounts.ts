import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { settingsForRepoOwner } from '@/store/repos/owner-routing'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'

export function useAutomationLaunchAccounts(projectId: string) {
  const settings = useAppStore((state) => state.settings)
  const repos = useAppStore((state) => state.repos)
  const target = getActiveRuntimeTarget(settingsForRepoOwner({ settings, repos }, projectId))
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [accounts, setAccounts] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    let cancelled = false
    setAccounts([])
    void callRuntimeRpc<{ codex: CodexRateLimitAccountsState; rateLimits: RateLimitState }>(
      environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
      'accounts.list',
      { refreshUsage: false }
    )
      .then((snapshot) => {
        if (cancelled) {
          return
        }
        setAccounts(
          snapshot.codex.accounts
            .filter((account) => account.managedHomeRuntime !== 'wsl')
            .map((account) => {
              const row = snapshot.rateLimits.accountCapacity?.codex.find(
                (row) => row.accountId === account.id
              )
              const detail = row?.planType ?? row?.detail
              return {
                value: account.id,
                label: detail ? `${account.email} (${detail})` : account.email
              }
            })
        )
      })
      .catch(() => {
        /* Keep saved IDs visible when the account owner is unavailable. */
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, projectId])
  return accounts
}
