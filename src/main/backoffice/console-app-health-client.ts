import { appHealthReportAnswer, type AppHealthReportBody } from '../../shared/app-health-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/** One write: a feature's health. Short timeout — a slow console must never hold the app. */
export function postAppHealth(
  body: AppHealthReportBody
): Promise<ConsoleWorkflowResult<Record<string, unknown>>> {
  return request('/api/app-health', 'POST', appHealthReportAnswer, body, 8_000)
}
