import { useAppStore } from '@/store'
import { getPersonRevealedAt } from '@/lib/restore-flood-guard'
import { isTabRevealed } from '../../terminal/deferred-startup-mount'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Why: a pane automatic sleep put down resumes only when a person opens its tab. Its tab is held
 * unmounted until then, except a split whose sibling still has a PTY: that tab mounts with every
 * other tab of a mounted worktree (an untargeted background mount, opening the workspace on
 * another tab, a remount after eviction). Connecting the slept pane there would cold-restore its
 * `--resume` in the background, the restart relaunch automatic sleep exists to end. So a hidden
 * slept pane whose tab was not opened (or targeted by a mount) waits, spawning nothing, and its
 * first reveal runs the ordinary connect, which resumes the agent once. The phone's per-terminal
 * open is such a reveal too (restore-flood-guard.ts notes it per tab, after the record slept).
 */
export function installSleptPaneConnectGate(session: ConnectPanePtySession): void {
  session.connectWaitsForTabOpen = false
  session.shouldWaitForTabOpenBeforeConnect = (): boolean => {
    if (session.disposed || session.deps.isVisibleRef.current || session.paneStartup) {
      return false
    }
    const record = session.getSleepingRecordForPane(useAppStore.getState())?.record
    return Boolean(
      record &&
      record.restoreOnTabOpenOnly === true &&
      record.resumeOnFirstReveal === true &&
      record.tabId &&
      !isTabRevealed(record.tabId) &&
      !((getPersonRevealedAt(record.tabId) ?? Number.NEGATIVE_INFINITY) >= record.capturedAt)
    )
  }
  session.releaseConnectWaitingForTabOpen = (): void => {
    if (!session.connectWaitsForTabOpen || session.disposed) {
      return
    }
    session.connectWaitsForTabOpen = false
    // Why the mount's scheduling: the frame lets fit measure the container that just became visible.
    session.connectFallbackTimer = setTimeout(session.runDeferredConnect, 250)
    session.connectFrame = requestAnimationFrame(session.runDeferredConnect)
  }
}
