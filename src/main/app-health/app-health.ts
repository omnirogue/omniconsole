import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import type { AppHealthReportInput } from '../../shared/app-health-contract'
import { postAppHealth } from '../backoffice/console-app-health-client'
import { isElectronOmniConsoleMcpSignedIn } from '../host/electron-omni-console-mcp-auth'
import { AppHealthReporter, type AppHealthSendResult } from './app-health-reporter'

let reporter: AppHealthReporter | null = null

function signedIn(): boolean {
  try {
    return isElectronOmniConsoleMcpSignedIn()
  } catch {
    return false
  }
}

export function appHealthReporter(): AppHealthReporter {
  reporter ??= new AppHealthReporter({
    send: postAppHealth,
    isSignedIn: signedIn,
    // Why the port and not electron: this module is reachable from the Orca runtime
    // (PTY env assembly), which must stay bootable on plain Node.
    appVersion: () => (hasAppEnvironment() ? getAppEnvironment().getVersion() : 'unknown'),
    platform: () => process.platform
  })
  return reporter
}

/** Fire-and-forget. Silent when signed out: health goes only to the person's own console. */
export function reportAppHealth(input: AppHealthReportInput): void {
  appHealthReporter().report(input)
}

export function reportAppHealthAndWait(input: AppHealthReportInput): Promise<AppHealthSendResult> {
  return appHealthReporter().reportAndWait(input)
}

export function _setAppHealthReporterForTests(next: AppHealthReporter | null): void {
  reporter = next
}
