import React from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isLazyChunkLoadError } from '@/lib/lazy-with-retry'
import {
  dismissReactErrorBoundaryReport,
  promptReactErrorBoundaryReport,
  reportReactErrorBoundaryCrash
} from '@/lib/react-error-boundary-reporting'
import type {
  CrashReportRecord,
  ReactErrorBoundaryReportArgs
} from '../../../../shared/crash-reporting'
import {
  getReactErrorBoundaryAttribution,
  UNRELIABLE_BOUNDARY_ATTRIBUTION
} from '../../../../shared/react-update-depth-attribution'
import { translate } from '@/i18n/i18n'

type BoundaryFallbackArgs = {
  error: Error | null
  reset: () => void
}

type Props = {
  boundaryId: string
  surface: ReactErrorBoundaryReportArgs['surface']
  children: React.ReactNode
  className?: string
  compact?: boolean
  reportAsCrash?: boolean
  resetKey?: string | number | boolean | null
  title?: string
  description?: string
  fallback?: (args: BoundaryFallbackArgs) => React.ReactNode
}

type State = {
  error: Error | null
  resetKey: Props['resetKey']
}

/** Why: React #185 is a burst of commits that ends on its own, so remount after it has passed. */
const UPDATE_DEPTH_RETRY_DELAYS_MS = [1_500, 5_000]
/** How long a retried surface must stay up before its crash counts as recovered. */
const RECOVERY_CONFIRM_MS = 3_000

export class RecoverableRenderErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }
  private updateDepthRetries = 0
  private updateDepthRetryTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryConfirmTimer: ReturnType<typeof setTimeout> | undefined
  // Why: a #185 the retry recovers from needs no one's attention, so its report waits on the outcome.
  private deferredReport: Promise<CrashReportRecord | null> | null = null

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey }
    }
    return null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(`[${this.props.boundaryId}] render crash contained by boundary`, error, errorInfo)
    clearTimeout(this.recoveryConfirmTimer)
    const retrying = this.scheduleUpdateDepthRetry(error)
    if (this.props.reportAsCrash === false) {
      return
    }
    if (isLazyChunkLoadError(error)) {
      // Contained by this fallback; recovery breadcrumbs live on the load path.
      return
    }
    const report = {
      boundaryId: this.props.boundaryId,
      surface: this.props.surface,
      error,
      errorInfo
    }
    if (retrying) {
      this.deferredReport ??= reportReactErrorBoundaryCrash(report, { deferPrompt: true })
      return
    }
    // Retries ran out and the surface stays broken: prompt as usual.
    const deferred = this.deferredReport
    this.deferredReport = null
    void deferred?.then((recorded) => recorded && promptReactErrorBoundaryReport(recorded))
    void reportReactErrorBoundaryCrash(report)
  }

  componentWillUnmount(): void {
    clearTimeout(this.updateDepthRetryTimer)
    clearTimeout(this.recoveryConfirmTimer)
  }

  private scheduleUpdateDepthRetry(error: Error): boolean {
    const delayMs = UPDATE_DEPTH_RETRY_DELAYS_MS[this.updateDepthRetries]
    if (
      delayMs === undefined ||
      getReactErrorBoundaryAttribution(error) !== UNRELIABLE_BOUNDARY_ATTRIBUTION
    ) {
      return false
    }
    this.updateDepthRetries += 1
    clearTimeout(this.updateDepthRetryTimer)
    this.updateDepthRetryTimer = setTimeout(() => {
      this.updateDepthRetryTimer = undefined
      this.setState({ error: null }, this.confirmRecoveryLater)
    }, delayMs)
    return true
  }

  private confirmRecoveryLater = (): void => {
    clearTimeout(this.recoveryConfirmTimer)
    this.recoveryConfirmTimer = setTimeout(() => {
      this.recoveryConfirmTimer = undefined
      const deferred = this.deferredReport
      if (!deferred || this.state.error) {
        return
      }
      this.deferredReport = null
      void deferred.then((recorded) => recorded && dismissReactErrorBoundaryReport(recorded))
    }, RECOVERY_CONFIRM_MS)
  }

  handleReset = (): void => {
    clearTimeout(this.updateDepthRetryTimer)
    this.updateDepthRetries = 0
    this.setState({ error: null }, this.confirmRecoveryLater)
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback({ error: this.state.error, reset: this.handleReset })
    }

    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground',
          this.props.compact ? 'min-h-9 py-2' : 'h-full min-h-0 py-8',
          this.props.className
        )}
        role="alert"
      >
        <div className="flex size-8 items-center justify-center rounded-full border border-destructive/25 bg-destructive/10 text-destructive">
          <AlertTriangle className="size-4" />
        </div>
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {this.props.title ??
              translate(
                'auto.components.error.boundaries.RecoverableRenderErrorBoundary.ab855c11f4',
                'This part of OmniConsole hit an error.'
              )}
          </div>
          <div className="max-w-md text-xs">
            {this.props.description ??
              translate(
                'auto.components.error.boundaries.RecoverableRenderErrorBoundary.34a189ae0f',
                'The rest of the app is still running. Retry this surface or switch away and come back.'
              )}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={this.handleReset}>
          <RotateCw className="size-3.5" />
          {translate(
            'auto.components.error.boundaries.RecoverableRenderErrorBoundary.55001880db',
            'Retry'
          )}
        </Button>
      </div>
    )
  }
}
