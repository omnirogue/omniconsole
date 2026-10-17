import { useNow } from './use-now'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { countAccountSessions } from '@/lib/account-session-counts'
import { translate } from '@/i18n/i18n'
import type { AccountCapacityRow } from '../../../shared/provider-account-capacity'

export function useAccountSessionCounts(
  accounts: readonly AccountCapacityRow[]
): Record<string, string> {
  const now = useNow(15_000)
  const archived = useSessionSidebarView((state) => state.archived)
  return useAppStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(countAccountSessions(state, accounts, archived, now)).map(([key, count]) => [
          key,
          translate(
            'conversationLauncher.accountSessions',
            'Active: {{active}} · Total: {{total}}',
            {
              active: `${count.active}${count.unknownActive ? '+' : ''}`,
              total: `${count.total}${count.unknownTotal ? '+' : ''}`
            }
          )
        ])
      )
    )
  )
}
