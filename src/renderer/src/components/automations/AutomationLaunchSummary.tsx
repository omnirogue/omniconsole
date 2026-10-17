import { translate } from '@/i18n/i18n'
import type { Automation } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import { useAutomationLaunchAccounts } from './use-automation-launch-accounts'

export function AutomationLaunchSummary({
  automation
}: {
  automation: Automation
}): React.JSX.Element | null {
  const accounts = useAutomationLaunchAccounts(getAutomationRunRepoId(automation))
  const preferences = automation.launchPreferences
  if (!preferences) {
    return null
  }
  const account = accounts.find((entry) => entry.value === preferences.codexAccountId)
  const summary = [
    preferences.model,
    preferences.effort,
    account?.label ?? preferences.codexAccountId
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">
        {translate('automations.launch.title', 'Launch')}
      </div>
      <div className="mt-1 break-words text-sm font-medium">
        {summary || translate('automations.launch.inherit', 'Inherit config')}
      </div>
    </div>
  )
}
