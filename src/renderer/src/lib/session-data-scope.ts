import { useCallback } from 'react'
import { localSessionDataRuntimeKey, useSessionDataRuntimeKey } from './session-data-runtime'
import { useAppStore, type AppState } from '@/store'

type ScopeState = Pick<AppState, 'activeOrcaProfileId' | 'orcaProfileAuthStatus' | 'settings'>
/** These queues belong to the local runtime, regardless of the selected workspace's host. */
export function sessionDataScopeKey(
  state: ScopeState,
  runtimeKey = localSessionDataRuntimeKey()
): string {
  const auth = state.orcaProfileAuthStatus
  return JSON.stringify([
    state.activeOrcaProfileId ?? null,
    auth?.state ?? null,
    auth?.cloud?.userId ?? null,
    auth?.cloud?.cloudProfileId ?? null,
    auth?.cloud?.activeOrgId ?? null,
    state.settings?.backofficeEnv ?? null,
    state.settings?.backofficeProductionUrl ?? null,
    state.settings?.backofficeLocalUrl ?? null,
    runtimeKey
  ])
}

export function useSessionDataScope(): string {
  const runtimeKey = useSessionDataRuntimeKey()
  return useAppStore(
    useCallback((state: AppState) => sessionDataScopeKey(state, runtimeKey), [runtimeKey])
  )
}

export function isSessionDataScopeCurrent(key: string): boolean {
  return sessionDataScopeKey(useAppStore.getState()) === key
}
