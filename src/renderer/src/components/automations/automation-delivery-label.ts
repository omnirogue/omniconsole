import type { AutomationDeliveryResult } from '../../../../shared/automation-definition-context'
import { translate } from '@/i18n/i18n'

export function automationDeliveryLabel(kind: AutomationDeliveryResult['kind']): string {
  switch (kind) {
    case 'chat':
      return translate('routines.output.chat', 'Chat')
    case 'slack':
    case 'slack-channel':
      return translate('routines.output.slack', 'Slack channel')
    case 'google-drive':
      return translate('routines.output.drive', 'Google Drive folder')
    case 'file':
      return translate('routines.output.file', 'File path')
    case 'hub-card':
      return translate('routines.output.hub', 'Hub card scope')
    case 'desktop':
      return translate('routines.notify.desktop', 'Desktop')
    case 'slack-dm':
      return translate('routines.notify.dm', 'Slack direct message')
    case 'email':
      return translate('routines.notify.email', 'Email')
  }
}
