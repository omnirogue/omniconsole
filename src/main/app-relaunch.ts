import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { runWithLaunchPath } from './startup/hydrate-shell-path'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'
  | 'outcome-continuation'

let replacementScheduled = false

export function hasAppRelaunchScheduled(): boolean {
  return replacementScheduled
}

export function relaunchApp(
  reason: AppRelaunchReason,
  data?: CrashReportBreadcrumbData,
  options?: { args: string[] }
): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  runWithLaunchPath(() => app.relaunch(options))
  replacementScheduled = true
}
