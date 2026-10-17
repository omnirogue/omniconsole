import type React from 'react'
import type {
  CrashReportRecord,
  ReactErrorBoundaryReportArgs
} from '../../../shared/crash-reporting'
import { getReactErrorBoundaryAttribution } from '../../../shared/react-update-depth-attribution'

type RendererErrorContext = Pick<
  ReactErrorBoundaryReportArgs,
  'activeView' | 'activeModal' | 'activeTabType' | 'activeRightSidebarTab' | 'hasActiveWorktree'
>

type BuildReportArgsInput = {
  boundaryId: string
  surface: ReactErrorBoundaryReportArgs['surface']
  error: unknown
  errorInfo?: React.ErrorInfo
  context?: RendererErrorContext
}

const reportedRendererErrorKeys: string[] = []
const reportedRendererErrorKeySet = new Set<string>()
const MAX_REPORTED_RENDERER_ERROR_KEYS = 50
let pendingReactErrorBoundaryReport: CrashReportRecord | null = null

export const REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT =
  'omni:react-error-boundary-report-available'

function stringFromThrown(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      ...(value.stack ? { stack: value.stack } : {})
    }
  }

  return {
    name: 'NonErrorThrown',
    message: String(value)
  }
}

async function collectRendererErrorContext(): Promise<RendererErrorContext> {
  try {
    const { useAppStore } = await import('@/store')
    const state = useAppStore.getState()
    return {
      activeView: state.activeView,
      activeModal: state.activeModal,
      activeTabType: state.activeTabType,
      activeRightSidebarTab: state.rightSidebarTab,
      hasActiveWorktree: state.activeWorktreeId !== null
    }
  } catch {
    return {}
  }
}

export function buildReactErrorBoundaryReportArgs({
  boundaryId,
  surface,
  error,
  errorInfo,
  context
}: BuildReportArgsInput): ReactErrorBoundaryReportArgs {
  const fields = stringFromThrown(error)
  const componentStack = errorInfo?.componentStack?.trim()
  // Derived here, not per boundary: React #185 lands on a bystander, so every boundary needs the caveat.
  const attribution = getReactErrorBoundaryAttribution(error)
  return {
    boundaryId,
    surface,
    errorName: fields.name,
    errorMessage: fields.message,
    ...(fields.stack ? { errorStack: fields.stack } : {}),
    ...(componentStack ? { componentStack } : {}),
    ...(attribution ? { attribution } : {}),
    ...(context?.activeView ? { activeView: context.activeView } : {}),
    ...(context?.activeModal !== undefined ? { activeModal: context.activeModal } : {}),
    ...(context?.activeTabType ? { activeTabType: context.activeTabType } : {}),
    ...(context?.activeRightSidebarTab
      ? { activeRightSidebarTab: context.activeRightSidebarTab }
      : {}),
    ...(context?.hasActiveWorktree !== undefined
      ? { hasActiveWorktree: context.hasActiveWorktree }
      : {})
  }
}

function rememberRendererErrorKey(key: string): boolean {
  if (reportedRendererErrorKeySet.has(key)) {
    return false
  }
  reportedRendererErrorKeySet.add(key)
  reportedRendererErrorKeys.push(key)
  if (reportedRendererErrorKeys.length > MAX_REPORTED_RENDERER_ERROR_KEYS) {
    const expiredKey = reportedRendererErrorKeys.shift()
    if (expiredKey) {
      reportedRendererErrorKeySet.delete(expiredKey)
    }
  }
  return true
}

function getRendererErrorKey(args: ReactErrorBoundaryReportArgs): string {
  return JSON.stringify({
    boundaryId: args.boundaryId,
    surface: args.surface,
    errorName: args.errorName,
    errorMessage: args.errorMessage,
    componentStack: args.componentStack
  })
}

export function takePendingReactErrorBoundaryReport(): CrashReportRecord | null {
  const report = pendingReactErrorBoundaryReport
  pendingReactErrorBoundaryReport = null
  return report
}

function notifyReactErrorBoundaryReportAvailable(report: CrashReportRecord): void {
  pendingReactErrorBoundaryReport = report
  window.dispatchEvent(new CustomEvent(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT))
}

/**
 * Records a boundary crash and returns the new report. `deferPrompt` keeps the dialog shut, for a
 * caller that first waits to see whether its surface recovers on its own.
 */
export async function reportReactErrorBoundaryCrash(
  input: Omit<BuildReportArgsInput, 'context'>,
  options: { deferPrompt?: boolean } = {}
): Promise<CrashReportRecord | null> {
  const context = await collectRendererErrorContext()
  const args = buildReactErrorBoundaryReportArgs({ ...input, context })
  if (!rememberRendererErrorKey(getRendererErrorKey(args))) {
    return null
  }

  try {
    const result = await window.api?.crashReports?.recordRendererError?.(args)
    if (result && !result.ok) {
      console.warn('[react-error-boundary] Failed to record renderer crash:', result.error)
      return null
    }
    if (result?.ok && result.report && !result.deduped) {
      if (!options.deferPrompt) {
        notifyReactErrorBoundaryReportAvailable(result.report)
      }
      return result.report
    }
  } catch (error) {
    console.warn('[react-error-boundary] Crash reporting IPC failed:', error)
  }
  return null
}

/** Opens the crash dialog for a report whose prompt was deferred. */
export function promptReactErrorBoundaryReport(report: CrashReportRecord): void {
  notifyReactErrorBoundaryReportAvailable(report)
}

/** Keeps a report on record without prompting for it, now or at the next launch. */
export async function dismissReactErrorBoundaryReport(report: CrashReportRecord): Promise<void> {
  try {
    await window.api?.crashReports?.dismiss?.({ reportId: report.id })
  } catch (error) {
    console.warn('[react-error-boundary] Could not dismiss a recovered crash report:', error)
  }
}

export function clearReactErrorBoundaryReportingForTest(): void {
  reportedRendererErrorKeys.length = 0
  reportedRendererErrorKeySet.clear()
  pendingReactErrorBoundaryReport = null
}
