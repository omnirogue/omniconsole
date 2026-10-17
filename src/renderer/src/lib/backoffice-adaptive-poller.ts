import { noteBackofficeActivity } from './backoffice-polling-activity'
import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
import { getWindowParkVisible, subscribeWindowParkVisibility } from './window-park-visibility'
import { installWindowVisibilityTimeoutPoller } from './window-visibility-timeout-poller'

/** Compose the existing serial timeout loop with activity and stale-visibility recovery. */
export function installBackofficeAdaptivePoller(
  run: (wake?: boolean) => Promise<void> | void,
  runOnStart = true
): () => void {
  let lastActivity = Date.now()
  let wasHidden = !getWindowParkVisible()
  let reconcile = false
  let focused = typeof document.hasFocus !== 'function' || document.hasFocus()
  const idle = () => Date.now() - lastActivity >= BACKOFFICE_POLLING.idleStopMs
  return installWindowVisibilityTimeoutPoller({
    run: () => {
      const wake = reconcile
      reconcile = false
      return run(wake)
    },
    runOnStart,
    canRun: () => !idle(),
    getDelayMs: () =>
      idle()
        ? null
        : Math.min(
            focused && getWindowParkVisible()
              ? BACKOFFICE_POLLING.focusedMs
              : BACKOFFICE_POLLING.hiddenMs,
            BACKOFFICE_POLLING.idleStopMs - (Date.now() - lastActivity)
          ),
    subscribeWake(wake, reschedule) {
      const activity = () => {
        const stopped = idle()
        lastActivity = Date.now()
        noteBackofficeActivity()
        if (stopped) {
          reconcile = true
          wake()
        }
      }
      const focus = () => {
        reconcile ||= wasHidden || idle()
        wasHidden = false
        focused = true
        noteBackofficeActivity()
        lastActivity = Date.now()
        wake()
      }
      const blur = () => {
        focused = false
        reschedule()
      }
      const visibility = () => {
        if (getWindowParkVisible()) {
          focus()
        } else {
          wasHidden = true
          reschedule()
        }
      }
      const stopVisibility = subscribeWindowParkVisibility(visibility)
      window.addEventListener('focus', focus)
      window.addEventListener('blur', blur)
      document.addEventListener('pointerdown', activity)
      document.addEventListener('keydown', activity)
      document.addEventListener('wheel', activity, { passive: true })
      return () => {
        stopVisibility()
        window.removeEventListener('focus', focus)
        window.removeEventListener('blur', blur)
        document.removeEventListener('pointerdown', activity)
        document.removeEventListener('keydown', activity)
        document.removeEventListener('wheel', activity)
      }
    }
  })
}
