import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppHealthReportInput } from '../../shared/app-health-contract'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const REPORTED_IDS_FILE = 'app-health-reported-crashes.json'
const REPORTED_IDS_KEEP = 200
/** First run with no bookkeeping: only crashes this recent count as new. */
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000

async function readReportedIds(userDataPath: string): Promise<string[] | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(userDataPath, REPORTED_IDS_FILE), 'utf8')
    )
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return null
  }
}

/** The health row for one crash: its id and reason, never dump bytes or details. */
export function crashHealthReport(report: CrashReportRecord): AppHealthReportInput {
  const reason = report.reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 64)
  return {
    feature: 'crash',
    status: 'crash',
    code: reason || 'unknown',
    message: `${report.id} ${report.processType} ${report.reason}`.trim(),
    at: report.createdAt
  }
}

/**
 * On launch, tell the console about each crash recorded since the last time we told
 * it. Persisted ids, not the report's own status: a report the person dismissed or
 * never sent is still a crash Sal should see counted.
 */
export async function reportNewCrashesOnLaunch(args: {
  userDataPath: string
  /** Signed out, nothing is sent — so nothing may be marked reported either, or the
   *  crash is lost forever once the person signs in. The routine simply waits. */
  signedIn: boolean
  listRecent: () => Promise<CrashReportRecord[]>
  /** Awaited: an id is recorded as reported only once the console accepted it. */
  report: (input: AppHealthReportInput) => Promise<{ ok: boolean }>
  now?: () => number
}): Promise<number> {
  if (!args.signedIn) {
    return 0
  }
  let recent: CrashReportRecord[]
  try {
    recent = await args.listRecent()
  } catch {
    return 0
  }
  const bookkeeping = await readReportedIds(args.userDataPath)
  const reported = bookkeeping ?? []
  const known = new Set(reported)
  const since = (args.now?.() ?? Date.now()) - FIRST_RUN_WINDOW_MS
  const fresh = recent.filter(
    (report) =>
      !known.has(report.id) && (bookkeeping !== null || Date.parse(report.createdAt) >= since)
  )
  const delivered: string[] = []
  for (const report of fresh) {
    try {
      if ((await args.report(crashHealthReport(report))).ok) {
        delivered.push(report.id)
      }
    } catch {
      // Why: an unreachable console leaves the id unrecorded; next launch tries again.
    }
  }
  // Baselined (too old to report) and delivered ids are recorded; a failed send is not.
  const baselined = recent
    .filter((report) => !known.has(report.id) && !fresh.includes(report))
    .map((report) => report.id)
  const unrecorded = [...baselined, ...delivered]
  if (unrecorded.length > 0) {
    const next = [...reported, ...unrecorded].slice(-REPORTED_IDS_KEEP)
    try {
      await writeFile(join(args.userDataPath, REPORTED_IDS_FILE), JSON.stringify(next))
    } catch {
      // Why: a failed bookkeeping write means a repeat row next launch, not a lost crash.
    }
  }
  return delivered.length
}
