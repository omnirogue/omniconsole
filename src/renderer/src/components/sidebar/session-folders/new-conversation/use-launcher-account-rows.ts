import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAccountCapacityRows } from '@/hooks/useAccountCapacityRows'
import { watchProviderAccounts } from '@/runtime/runtime-provider-accounts-client'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../../shared/provider-account-capacity'

export type LauncherAccountRow = AccountCapacityRow & {
  /** The owner that supplied the account and its host-local launch paths. */
  runtimeEnvironmentId?: string
}
type Rows = Record<CapacityProvider, LauncherAccountRow[]>
const EMPTY: Rows = { claude: [], codex: [] }

export function useLauncherAccountRows(environmentId: string | null) {
  const claude = useAccountCapacityRows('claude')
  const codex = useAccountCapacityRows('codex')
  const [remote, setRemote] = useState<{ owner: string; rows: Rows; error?: string } | null>(null)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId: environmentId },
      {
        onSnapshot(snapshot) {
          if (!current) {
            return
          }
          const capacity = snapshot.rateLimits?.accountCapacity
          const stamp = (rows: AccountCapacityRow[] | undefined) =>
            (rows ?? []).map((row) => ({ ...row, runtimeEnvironmentId: environmentId }))
          setRemote({
            owner: environmentId,
            rows: { claude: stamp(capacity?.claude), codex: stamp(capacity?.codex) },
            error: capacity
              ? undefined
              : translate(
                  'computerPicker.accountsUnsupported',
                  'Update this computer’s runtime to view its account availability.'
                )
          })
        },
        onError(error) {
          if (current) {
            setRemote({ owner: environmentId, rows: EMPTY, error: String(error) })
          }
        }
      }
    )
    return () => {
      current = false
      watcher.close()
    }
  }, [environmentId])
  return environmentId
    ? remote?.owner === environmentId
      ? { ...remote.rows, error: remote.error }
      : { ...EMPTY, error: undefined }
    : { claude, codex, error: undefined }
}
