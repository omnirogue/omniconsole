import { WorkflowRequestError } from '@/lib/console-workflow-client'
import type { ConsoleDriveApi } from '../../../../shared/console-drive-contract'
import { translate } from '@/i18n/i18n'

export function driveApi(): ConsoleDriveApi {
  const api = window.api?.consoleDrive
  if (!api) {
    throw new WorkflowRequestError({
      code: 'capability_unavailable',
      message: translate(
        'auto.components.task.drive.drive.client.8adc1e4a5d',
        'Google Drive needs an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}
