import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { resolvePaneReattachPtyId } from './reattach-candidate-pty'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import { toProcessExitStartup } from './process-exit-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function showAttachOnlyRecovery(session: ConnectPanePtySession): void {
  if (session.disposed) {
    return
  }
  session.deps.onPaneProcessDied?.({
    paneId: session.pane.id,
    exitCode: 0,
    reason: 'viewer-unavailable',
    startup: toProcessExitStartup(
      session.buildColdRestoreAgentResumeStartup?.() ?? session.paneStartup
    )
  })
}

export function attachOnlyViewer(session: ConnectPanePtySession): void {
  session.allowInitialIdleCacheSeed = false
  void (async () => {
    const candidate = resolvePaneReattachPtyId(session, useAppStore.getState())
    const ptyId = candidate ?? (await pendingSpawnByPaneKey.get(session.pendingSpawnKey))
    if (session.disposed) {
      return
    }
    if (!ptyId) {
      showAttachOnlyRecovery(session)
      return
    }
    // Only the execution host can confirm a persisted local or SSH PTY still exists.
    if (!isRemoteRuntimePtyId(ptyId) && (await window.api.pty.hasPty(ptyId)) !== true) {
      showAttachOnlyRecovery(session)
      return
    }
    if (session.disposed) {
      return
    }
    if (!session.attachRetainedLegacyPty(ptyId)) {
      showAttachOnlyRecovery(session)
    }
  })().catch(() => showAttachOnlyRecovery(session))
}
