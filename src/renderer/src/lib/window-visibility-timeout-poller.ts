import { isWindowVisible } from './window-visibility-interval'

export type WindowVisibilityTimeoutPollerTimer = ReturnType<typeof setTimeout>

export function installWindowVisibilityTimeoutPoller(args: {
  run: () => Promise<void> | void
  getDelayMs: () => number | null
  runOnStart?: boolean
  canRun?: () => boolean
  subscribeWake?: (wake: () => void, reschedule: () => void) => () => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => WindowVisibilityTimeoutPollerTimer
  clearTimeoutFn?: (handle: WindowVisibilityTimeoutPollerTimer) => void
}): () => void {
  const setTimeoutFn =
    args.setTimeoutFn ??
    ((callback: () => void, delayMs: number): WindowVisibilityTimeoutPollerTimer =>
      setTimeout(callback, delayMs))
  const clearTimeoutFn =
    args.clearTimeoutFn ??
    ((handle: WindowVisibilityTimeoutPollerTimer): void => clearTimeout(handle))
  const canRun = args.canRun ?? isWindowVisible
  let timeoutId: WindowVisibilityTimeoutPollerTimer | null = null
  let disposed = false
  let inFlight = false

  const clearScheduledPoll = (): void => {
    if (!timeoutId) {
      return
    }
    clearTimeoutFn(timeoutId)
    timeoutId = null
  }

  const schedulePoll = (): void => {
    clearScheduledPoll()
    if (disposed || !canRun()) {
      return
    }
    const delay = args.getDelayMs()
    if (delay === null) {
      return
    }
    timeoutId = setTimeoutFn(() => {
      timeoutId = null
      runAndSchedule()
    }, delay)
  }

  function runAndSchedule(): void {
    clearScheduledPoll()
    if (disposed || !canRun() || inFlight) {
      return
    }
    inFlight = true
    void Promise.resolve(args.run()).finally(() => {
      inFlight = false
      schedulePoll()
    })
  }

  const reconcileVisibility = (): void => {
    if (canRun()) {
      runAndSchedule()
    } else {
      clearScheduledPoll()
    }
  }

  if (args.runOnStart === false) {
    schedulePoll()
  } else {
    runAndSchedule()
  }
  const unsubscribeWake = args.subscribeWake?.(runAndSchedule, schedulePoll)
  if (
    !args.subscribeWake &&
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('focus', reconcileVisibility)
  }
  if (
    !args.subscribeWake &&
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('visibilitychange', reconcileVisibility)
  }

  return () => {
    disposed = true
    unsubscribeWake?.()
    clearScheduledPoll()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', reconcileVisibility)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcileVisibility)
    }
  }
}
