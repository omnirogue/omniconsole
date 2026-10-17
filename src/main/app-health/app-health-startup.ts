import type { CrashReportRecord } from '../../shared/crash-reporting'
import { reportAppHealth, reportAppHealthAndWait } from './app-health'
import { reportNewCrashesOnLaunch } from './crash-health-on-launch'

/**
 * On ready: one `startup` row (version and platform ride on every row; the code
 * says whether the person was signed in), then a `crash` row per crashpad report
 * that has not been reported before. Signed out, the reporter sends nothing.
 */
export function reportStartupHealth(args: {
  signedIn: boolean
  userDataPath: string
  listRecentCrashes: (() => Promise<CrashReportRecord[]>) | null
}): void {
  reportAppHealth({
    feature: 'startup',
    status: 'ok',
    code: args.signedIn ? 'signed_in' : 'signed_out',
    message: `ready; signed_in=${args.signedIn}`
  })
  if (args.listRecentCrashes) {
    void reportNewCrashesOnLaunch({
      userDataPath: args.userDataPath,
      signedIn: args.signedIn,
      listRecent: args.listRecentCrashes,
      report: reportAppHealthAndWait
    }).catch(() => undefined)
  }
}
