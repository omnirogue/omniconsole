import { translate } from '@/i18n/i18n'
import type { LauncherCapability } from './resolve-launch-plan'

export function launcherUnavailableMessage(
  capabilities: LauncherCapability[],
  loading = false
): string {
  if (capabilities.some((entry) => entry.status === 'work-plan-required')) {
    return translate(
      'conversations.workPlanRequired',
      'This work location is linked to a task. Open that task to start its approved work plan, or choose another work location.'
    )
  }
  return loading
    ? translate('conversations.checkingAgents', 'Checking available agents…')
    : translate(
        'conversations.noneAvailable',
        'No agents are ready. Check agent status in Settings or try again.'
      )
}
