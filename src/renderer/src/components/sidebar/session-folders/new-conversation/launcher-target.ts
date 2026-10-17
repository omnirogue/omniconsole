import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CompanySessionTarget } from '@/lib/start-company-session'
import { useAppStore } from '@/store'

export type LauncherCompany = CompanySessionTarget['company']
// Why: company choices belong to the signed-in console scope, never another account's launcher.
export const useLauncherTargets = create<{ companies: Record<string, LauncherCompany> }>()(
  persist(
    () => ({
      companies: {}
    }),
    { name: 'omni.conversation-launcher-companies.v1' }
  )
)
export function rememberLauncherCompany(scope: string, company: LauncherCompany): void {
  useLauncherTargets.setState((state) => ({ companies: { ...state.companies, [scope]: company } }))
}
export function openLauncherAccounts(): void {
  useAppStore.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
  useAppStore.getState().openSettingsPage()
}
