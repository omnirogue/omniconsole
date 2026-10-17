import type { AppState } from '@/store/types'

/**
 * Keys saved per-person state (handoff retries, assisted briefs) to the Orca profile,
 * cloud account, organisation and Console environment, so switching any of them isolates it.
 */
export function selectConsoleAccountScope(state: AppState): string {
  return JSON.stringify([
    state.activeOrcaProfileId,
    state.orcaProfileAuthStatus?.state,
    state.orcaProfileAuthStatus?.cloud?.userId,
    state.orcaProfileAuthStatus?.cloud?.cloudProfileId,
    state.orcaProfileAuthStatus?.cloud?.activeOrgId,
    state.settings?.backofficeEnv,
    state.settings?.backofficeLocalUrl,
    state.settings?.backofficeProductionUrl
  ])
}
