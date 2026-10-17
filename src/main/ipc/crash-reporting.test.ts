import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const {
  handlers,
  listeners,
  clipboardWriteTextMock,
  collectDiagnosticBundleMock,
  getDiagnosticsStatusMock,
  recordCrashBreadcrumbMock,
  resolveDiagnosticOrcaChannelMock,
  spanEndMock,
  startSpanMock,
  reportAppHealthAndWaitMock
} = vi.hoisted(() => {
  const spanEndMock = vi.fn()
  return {
    handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
    listeners: new Map<string, (_event: unknown, args?: unknown) => void>(),
    clipboardWriteTextMock: vi.fn(),
    collectDiagnosticBundleMock: vi.fn(),
    getDiagnosticsStatusMock: vi.fn(),
    recordCrashBreadcrumbMock: vi.fn(),
    resolveDiagnosticOrcaChannelMock: vi.fn(),
    spanEndMock,
    startSpanMock: vi.fn(() => ({
      traceId: 'trace-id',
      spanId: 'span-id',
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      interrupt: vi.fn(),
      end: spanEndMock
    })),
    reportAppHealthAndWaitMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  clipboard: { writeText: clipboardWriteTextMock },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

// Why: crash reports go to the console's app-health route (Sal 2026-09-13), never onorca.dev.
vi.mock('../app-health/app-health', () => ({
  reportAppHealthAndWait: reportAppHealthAndWaitMock
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  // Renderer breadcrumb routing is covered in crash-reporting-renderer-breadcrumbs.test.ts.
  recordCoalescedCrashBreadcrumb: vi.fn(),
  recordCrashBreadcrumb: (...args: unknown[]) => recordCrashBreadcrumbMock(...args)
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: resolveDiagnosticOrcaChannelMock
}))

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

import {
  _getCrashReportingStateSizesForTests,
  _resetRendererErrorReportDedupeForTests,
  registerCrashReportingHandlers
} from './crash-reporting'

function diagnosticBundle(): ReturnType<typeof collectDiagnosticBundleMock> {
  return {
    bundleSubmissionId: 'bundleabcdefghijklmnop',
    payload: '{"type":"bundle-header"}\n',
    bytes: 25,
    spanCount: 1
  }
}

function report(
  status: CrashReportRecord['status'] = 'pending',
  id = 'crash-1'
): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-16T01:00:00.000Z',
    status,
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: {}
  }
}

describe('registerCrashReportingHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    clipboardWriteTextMock.mockReset()
    collectDiagnosticBundleMock.mockReset()
    collectDiagnosticBundleMock.mockReturnValue(diagnosticBundle())
    getDiagnosticsStatusMock.mockReset()
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      otlpEnabled: false,
      bundleEnabled: true,
      otlpStatus: 'Disabled',
      traceFilePath: '/tmp/main.trace.ndjson',
      traceFamilySize: 25
    })
    resolveDiagnosticOrcaChannelMock.mockReset()
    resolveDiagnosticOrcaChannelMock.mockReturnValue('stable')
    startSpanMock.mockClear()
    spanEndMock.mockClear()
    reportAppHealthAndWaitMock.mockReset()
    recordCrashBreadcrumbMock.mockReset()
    reportAppHealthAndWaitMock.mockResolvedValue({ ok: true })
    _resetRendererErrorReportDedupeForTests()
  })

  it('copies the requested captured report to the clipboard', async () => {
    const latest = report()
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      reportId: latest.id,
      notes: 'extra /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[Crash Report]'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      expect.stringContaining('extra [redacted-path]')
    )
  })

  it('copies an uncaptured crash report when the caller intentionally omits reportId', async () => {
    const pending = report('pending', 'crash-late-pending')
    const listRecent = vi.fn(async () => [pending])
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent,
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      notes: 'after opening /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('not captured'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[redacted-path]'))
    expect(clipboardWriteTextMock).not.toHaveBeenCalledWith(
      expect.stringContaining('crash-late-pending')
    )
    expect(listRecent).not.toHaveBeenCalled()
  })

  it('copies sanitized submission and diagnostic omission failures for a captured report', async () => {
    const pending = report('pending', 'crash-copy-failure')
    registerCrashReportingHandlers({
      getById: vi.fn(async () => pending),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [pending]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      reportId: pending.id,
      notes: 'current notes',
      submissionFailure: {
        error: 'fallback failed at C:\\Users\\alice\\Orca',
        diagnosticContext: {
          status: 'not_uploaded',
          reason: 'attachment token=super-secret-value',
          internalEndpointError: 'must-not-cross-copy-boundary'
        },
        diagnosticBundleFailure: 'must-not-cross-copy-boundary'
      }
    })

    expect(result).toEqual({ ok: true })
    const copiedText = String(clipboardWriteTextMock.mock.calls[0]?.[0])
    expect(copiedText).toContain('Report ID: crash-copy-failure')
    expect(copiedText).toContain('Submission failure:')
    expect(copiedText).toContain('Report error: fallback failed at [redacted-path]')
    expect(copiedText).toContain('Diagnostic logs not uploaded: attachment token=[redacted]')
    expect(copiedText).not.toContain('alice')
    expect(copiedText).not.toContain('must-not-cross-copy-boundary')
  })

  it('returns dismissed unsent reports for the manual Help menu entry', async () => {
    const dismissed = report('dismissed', 'crash-help-menu')
    registerCrashReportingHandlers({
      getById: vi.fn(async () => dismissed),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [report('sent', 'crash-sent'), dismissed]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(handlers.get('crashReports:getLatestPending')?.(null)).resolves.toBeNull()
    await expect(handlers.get('crashReports:getLatestReport')?.(null)).resolves.toEqual(dismissed)
  })

  it('submits a pending report as an app-health crash row and marks it sent', async () => {
    const pending = report('pending', 'crash-pending')
    const sent = report('sent', pending.id)
    const markSent = vi.fn(async () => sent)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => pending),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [pending]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: pending.id,
      notes: 'extra /Users/alice/project',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: sent,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason:
          'Crash logs stay on this machine; the console received only the crash id and reason.'
      }
    })
    // Only the id, the reason and the sanitized note: no dump bytes, no logs, no path.
    expect(reportAppHealthAndWaitMock).toHaveBeenCalledWith({
      feature: 'crash',
      status: 'crash',
      code: 'crashed',
      message: 'crash-pending renderer crashed — note: extra [redacted-path]',
      at: pending.createdAt
    })
    expect(collectDiagnosticBundleMock).not.toHaveBeenCalled()
    expect(markSent).toHaveBeenCalledWith(pending.id)
  })

  it('submits an uncaptured Help menu crash report as an app-health crash row', async () => {
    const pending = report('pending', 'crash-late-pending')
    const markSent = vi.fn()
    const listRecent = vi.fn(async () => [pending])
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent,
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      notes: 'blank window after opening /Users/alice/project',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: null,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason:
          'Crash logs stay on this machine; the console received only the crash id and reason.'
      }
    })
    expect(reportAppHealthAndWaitMock).toHaveBeenCalledWith({
      feature: 'crash',
      status: 'crash',
      code: 'uncaptured',
      message:
        'Crash reported from the Help menu without a captured report. — note: blank window after opening [redacted-path]'
    })
    expect(markSent).not.toHaveBeenCalled()
    expect(listRecent).not.toHaveBeenCalled()
  })

  it('keeps diagnostic logs local whether or not the person asked to include them', async () => {
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    for (const includeDiagnosticLogs of [true, false]) {
      const result = await handlers.get('crashReports:submit')?.(null, {
        notes: 'manual report',
        includeDiagnosticLogs,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
      expect(result).toEqual({
        ok: true,
        report: null,
        diagnosticBundle: {
          status: 'not_uploaded',
          reason:
            'Crash logs stay on this machine; the console received only the crash id and reason.'
        }
      })
    }
    expect(collectDiagnosticBundleMock).not.toHaveBeenCalled()
  })

  it('submits a dismissed startup prompt as a crash row and marks it sent', async () => {
    const dismissed = report('dismissed', 'crash-dismissed')
    const sent = report('sent', dismissed.id)
    const markDismissedSent = vi.fn(async () => sent)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => dismissed),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent,
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: dismissed.id,
      notes: 'sent from startup prompt',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: true,
      report: sent,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason:
          'Crash logs stay on this machine; the console received only the crash id and reason.'
      }
    })
    expect(reportAppHealthAndWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'crash',
        message: expect.stringContaining('sent from startup prompt')
      })
    )
    expect(markDismissedSent).toHaveBeenCalledWith(dismissed.id)
  })

  it('dismisses a pending report locally without any network submission', async () => {
    const latest = report('pending', 'crash-dismiss')
    const dismissed = report('dismissed', latest.id)
    const dismiss = vi.fn(async () => dismissed)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss,
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:dismiss')?.(null, {
      reportId: latest.id
    })

    expect(result).toEqual(dismissed)
    expect(dismiss).toHaveBeenCalledWith(latest.id)
    expect(reportAppHealthAndWaitMock).not.toHaveBeenCalled()
  })

  it('keeps a pending report available if the console refuses the crash row', async () => {
    const pending = report('pending', 'crash-failed')
    const markSent = vi.fn()
    reportAppHealthAndWaitMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'The backoffice could not be reached.'
    })
    registerCrashReportingHandlers({
      getById: vi.fn(async () => pending),
      dismiss: vi.fn(),
      markSent,
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [pending]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:submit')?.(null, {
      reportId: pending.id,
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    })

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'The backoffice could not be reached.',
      report: pending,
      diagnosticBundle: {
        status: 'not_uploaded',
        reason:
          'Crash logs stay on this machine; the console received only the crash id and reason.'
      }
    })
    expect(markSent).not.toHaveBeenCalled()
  })

  it('bounds submitted report ids by evicting the oldest successful sends', async () => {
    registerCrashReportingHandlers({
      getById: vi.fn(async (reportId: string) => report('pending', reportId)),
      dismiss: vi.fn(),
      markSent: vi.fn(async (reportId: string) => report('sent', reportId)),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    for (let i = 0; i < 260; i += 1) {
      await handlers.get('crashReports:submit')?.(null, {
        reportId: `crash-${i}`,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
    }

    expect(_getCrashReportingStateSizesForTests().submittedReportIds).toBe(256)
  })

  it('records a deduped renderer error boundary report through the crash store', async () => {
    const recorded = report('pending', 'react-render')
    const recordMock = vi.fn(async () => recorded)
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const args = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      errorMessage: 'Cannot read /Users/alice/project/token=abc123',
      errorStack: 'TypeError: nope\n    at /Users/alice/project/App.tsx:12:1',
      componentStack: 'at Terminal\nat App',
      activeView: 'terminal',
      activeModal: 'none',
      activeTabType: 'terminal',
      activeRightSidebarTab: 'source-control',
      hasActiveWorktree: true
    }

    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: recorded,
      deduped: false
    })
    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        processType: 'react-render',
        reason: 'react-error-boundary',
        exitCode: null,
        appVersion: '1.2.3-test',
        details: expect.objectContaining({
          boundary_id: 'terminal.workbench',
          surface: 'terminal-workbench',
          error_name: 'TypeError',
          error_message: 'Cannot read /Users/alice/project/token=abc123',
          active_view: 'terminal',
          active_modal: 'none',
          active_tab_type: 'terminal',
          right_sidebar_tab: 'source-control',
          has_active_worktree: true
        })
      })
    )
  })

  it('rejects invalid renderer error boundary surfaces', async () => {
    const recordMock = vi.fn()
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        boundaryId: 'terminal.workbench',
        surface: 'unknown',
        errorName: 'TypeError',
        errorMessage: 'nope'
      })
    ).resolves.toEqual({ ok: false, error: 'Invalid renderer error report.' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('bounds renderer error dedupe keys by evicting the oldest unique reports', async () => {
    let recordCount = 0
    const recordMock = vi.fn(async () => report('pending', `react-render-${recordCount++}`))
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const baseArgs = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      componentStack: 'at Terminal'
    }

    for (let i = 0; i < 260; i += 1) {
      await handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: `unique-render-error-${i}`
      })
    }

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-0'
      })
    ).resolves.toEqual({
      ok: true,
      report: expect.objectContaining({ id: 'react-render-260' }),
      deduped: false
    })
    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-259'
      })
    ).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(261)
  })
})
