import os from 'node:os'
import { app } from 'electron'
import {
  type CrashReportDiagnosticBundle,
  type CrashReportSubmitArgs,
  type CrashReportSubmitResult,
  formatUncapturedCrashReportText,
  sanitizeCrashReportString
} from '../../shared/crash-reporting'
import type { AppHealthReportInput } from '../../shared/app-health-contract'
import { reportAppHealthAndWait } from '../app-health/app-health'
import { crashHealthReport } from '../app-health/crash-health-on-launch'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  getRequestedCrashReport,
  inFlightSubmissions,
  rememberSubmittedReportId,
  submittedReportIds
} from './crash-reporting-sendable-reports'

/**
 * Where a crash report goes (Sal, 2026-09-13): the console's `POST /api/app-health`
 * as a `crash` row — the report id, the reason and the person's note, never dump
 * bytes or logs. Nothing on this path reaches onorca.dev any more. Diagnostic
 * logs stay on this machine; the dialog's "Copy diagnostics" is how they travel.
 */
const LOGS_STAY_LOCAL: CrashReportDiagnosticBundle = {
  status: 'not_uploaded',
  reason: 'Crash logs stay on this machine; the console received only the crash id and reason.'
}

export function buildUncapturedCrashReportText(
  notes: string | undefined,
  diagnosticBundle?: CrashReportDiagnosticBundle
): string {
  return formatUncapturedCrashReportText(
    {
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: os.platform(),
      osRelease: os.release(),
      arch: os.arch(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown'
    },
    notes,
    diagnosticBundle
  )
}

function withNotes(input: AppHealthReportInput, notes: string | undefined): AppHealthReportInput {
  const note = notes?.trim() ? sanitizeCrashReportString(notes.trim()) : ''
  return note ? { ...input, message: `${input.message ?? ''} — note: ${note}`.trim() } : input
}

export async function submitCrashReport(
  store: CrashReportStore,
  args: CrashReportSubmitArgs
): Promise<CrashReportSubmitResult> {
  const report = await getRequestedCrashReport(store, args)
  if (!report) {
    const result = await reportAppHealthAndWait(
      withNotes(
        {
          feature: 'crash',
          status: 'crash',
          code: 'uncaptured',
          message: 'Crash reported from the Help menu without a captured report.'
        },
        args.notes
      )
    )
    return result.ok
      ? { ok: true, report: null, diagnosticBundle: LOGS_STAY_LOCAL }
      : {
          ok: false,
          status: result.status,
          error: result.error,
          report: null,
          diagnosticBundle: LOGS_STAY_LOCAL
        }
  }
  const canSubmitDismissedReport = Boolean(args.reportId && report.status === 'dismissed')
  if (
    (!canSubmitDismissedReport && report.status !== 'pending') ||
    submittedReportIds.has(report.id)
  ) {
    return {
      ok: true,
      report: submittedReportIds.has(report.id) ? { ...report, status: 'sent' } : report
    }
  }
  if (inFlightSubmissions.has(report.id)) {
    return {
      ok: false,
      status: null,
      error: 'Crash report submission already in progress.',
      report
    }
  }

  inFlightSubmissions.add(report.id)
  try {
    const result = await reportAppHealthAndWait(withNotes(crashHealthReport(report), args.notes))
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        report,
        diagnosticBundle: LOGS_STAY_LOCAL
      }
    }
    rememberSubmittedReportId(report.id)
    const mark = report.status === 'dismissed' ? store.markDismissedSent : store.markSent
    try {
      // Why: startup prompts are dismissed before the user can send from the
      // still-open dialog, so a successful upload must update storage either way.
      const sent = await mark.call(store, report.id)
      return {
        ok: true,
        report: sent ?? { ...report, status: 'sent' },
        diagnosticBundle: LOGS_STAY_LOCAL
      }
    } catch (error) {
      // Why: the upstream submission already succeeded. A local persistence
      // failure must not present as upload failure or invite duplicate sends.
      console.error('[crash-reporting] Failed to mark crash report sent:', error)
      return { ok: true, report: { ...report, status: 'sent' }, diagnosticBundle: LOGS_STAY_LOCAL }
    }
  } finally {
    inFlightSubmissions.delete(report.id)
  }
}
