import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'

/** Tells the person when a launch started on a rate-limited or a fallback account. */
export function announceLaunchAccount(plan: {
  limitedAccount?: AccountCapacityRow
  fallbackAccount?: AccountCapacityRow
}): void {
  if (plan.limitedAccount) {
    toast.info(
      translate(
        'conversationLauncher.limitedLaunch',
        'This account is rate limited; launching anyway.'
      )
    )
  }
  if (plan.fallbackAccount) {
    toast.info(
      translate('conversationLauncher.accountFallback', 'Started with {{account}}.', {
        account:
          plan.fallbackAccount.email ?? translate('conversationLauncher.system', 'System login')
      })
    )
  }
}
