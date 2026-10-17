import { attachOnlyViewer } from './attach-only-viewer'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { isWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import { getEagerPtyBufferHandle } from '../pty-dispatcher'

import {
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey,
  recordPtyConnectDiagnostic
} from './pty-connect-limits'
import {
  isRemoteRuntimePtyId,
  canRestorePairedParkedTerminal,
  isSessionOwnedByWorktree
} from './paired-parked-terminal-restore'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { resolveLocalReattachCandidates } from './reattach-candidate-pty'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function runDeferredSessionReattachChoice(session: ConnectPanePtySession): void {
  if (session.deps.attachOnly) {
    attachOnlyViewer(session)
    return
  }
  // Why: re-read session IDs here rather than at connect scheduling — cleanup during the caller's one-frame gap could otherwise reattach a dead session.
  const storeSnapshot = useAppStore.getState()
  // Why shared: the restore flood guard's connect gate probes exactly this candidate.
  const { restoredPtyId, existingPtyId, tabFallbackPtyId, candidatePtyId } =
    resolveLocalReattachCandidates(session, storeSnapshot)
  const hasSleepingAgentSession = Boolean(session.getSleepingRecordForPane(storeSnapshot))

  const restoredSessionId = restoredPtyId ?? null
  const sleptRemoteRuntimeSessionId =
    restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && hasSleepingAgentSession
      ? restoredSessionId
      : null
  const detachedLivePtyId =
    tabFallbackPtyId && !session.hadExistingPaneTransportAtConnect && !sleptRemoteRuntimeSessionId
      ? restoredSessionId
        ? restoredSessionId === tabFallbackPtyId
          ? restoredSessionId
          : null
        : tabFallbackPtyId
      : null
  const detachedRemoteLeafPtyId =
    restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && !hasSleepingAgentSession
      ? restoredSessionId
      : null
  // Equals `restored && restored !== detachedLive ? restored : detachedLive`: a restored leaf id
  // always wins, else the tab fallback when no transport existed at connect.
  const candidateReattachSessionId = candidatePtyId
  const runtimeHostPtyWakeHint =
    session.runtimeEnvironmentId &&
    candidateReattachSessionId &&
    !isRemoteRuntimePtyId(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  const sleptRemoteColdRestoreStartup = sleptRemoteRuntimeSessionId
    ? session.buildColdRestoreAgentResumeStartup()
    : null
  if (sleptRemoteRuntimeSessionId) {
    session.deps.syncPanePtyLayoutBinding(session.pane.id, null)
    session.deps.clearTabPtyId(session.deps.tabId, sleptRemoteRuntimeSessionId)
  }
  const currentTabLivePtyIds = storeSnapshot.ptyIdsByTabId[session.deps.tabId] ?? []
  const candidateHasEagerBuffer = Boolean(
    candidateReattachSessionId &&
    !isRemoteRuntimePtyId(candidateReattachSessionId) &&
    getEagerPtyBufferHandle(candidateReattachSessionId)
  )
  // Why: a still-live locally-spawned PTY (e.g. a background automation agent) keeps an eager buffer until a pane adopts it.
  // It must be adopted via attach()+replay — connect({ sessionId }) on its non-session ptyId would spawn a fresh shell and orphan the agent.
  const eagerLivePtyId =
    candidateReattachSessionId &&
    candidateHasEagerBuffer &&
    currentTabLivePtyIds.includes(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  // Why: after a daemon crash + cold restore, a stale session-to-tab mapping can make a tab hold a ptyId from another worktree.
  // Restoring it would paint the wrong terminal content, so drop the reattach and spawn fresh.
  const legacyAttachOnlyPtyId = session.isLegacyWorkerAutomaticResumeBlocked()
    ? candidateReattachSessionId
    : null
  const pairedParkedReattachSessionId =
    session.mountFollowsTerminalPark &&
    candidateReattachSessionId &&
    isRemoteRuntimePtyId(candidateReattachSessionId) &&
    canRestorePairedParkedTerminal(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  const deferredReattachSessionId = legacyAttachOnlyPtyId
    ? null
    : (runtimeHostPtyWakeHint ??
      pairedParkedReattachSessionId ??
      (candidateReattachSessionId &&
      !isRemoteRuntimePtyId(candidateReattachSessionId) &&
      !candidateHasEagerBuffer &&
      isSessionOwnedByWorktree(candidateReattachSessionId, session.deps.worktreeId)
        ? candidateReattachSessionId
        : null))
  recordPtyConnectDiagnostic(
    `pane=${session.pane.id} tab=${session.deps.tabId} restored=${restoredPtyId} existing=${existingPtyId} detached=${detachedRemoteLeafPtyId ?? detachedLivePtyId} reattach=${deferredReattachSessionId} hasTransport=${session.hadExistingPaneTransportAtConnect} pendingKey=${session.pendingSpawnKey}`
  )

  if (deferredReattachSessionId) {
    startDeferredSessionReattach(session, deferredReattachSessionId)
  } else if (
    legacyAttachOnlyPtyId ||
    detachedRemoteLeafPtyId ||
    detachedLivePtyId ||
    eagerLivePtyId
  ) {
    // Why: mirrored web-leaf panes must attach to their exact remote PTY, not spawn a replacement host tab.
    // eagerLivePtyId covers a still-live background PTY (e.g. an automation agent) with a live eager buffer to adopt.
    const attachPtyId =
      legacyAttachOnlyPtyId ?? detachedRemoteLeafPtyId ?? detachedLivePtyId ?? eagerLivePtyId!
    recordPtyConnectDiagnostic(`pane=${session.pane.id} -> ATTACH detached=${attachPtyId}`)
    session.allowInitialIdleCacheSeed = false
    if (legacyAttachOnlyPtyId) {
      if (session.attachRetainedLegacyPty(legacyAttachOnlyPtyId) && session.connectionId) {
        useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
      }
    } else {
      // Why: surface synchronous attach failures via session.reportError so the pane shows a diagnostic instead of a blank surface.
      // On throw, clear the stale ptyId from the tab and fresh-spawn — else the next remount reads the same dead id and loops here.
      try {
        session.clearPaneMode2031State()
        session.clearHiddenOutputRestoreState()
        const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
        session.transport.attach({
          existingPtyId: attachPtyId,
          cols: session.cols,
          rows: session.rows,
          callbacks: outputCallbacks.callbacks
        })
        const attachedPtyId = session.transport.getPtyId() ?? attachPtyId
        session.bindActivePanePty(attachedPtyId, {
          updateTabPtyId: 'if-missing',
          sampleVisibleForegroundAgent: true
        })
        if (attachPtyId === eagerLivePtyId || isRemoteRuntimePtyId(attachedPtyId)) {
          session.registerPaneSerializerFor(attachedPtyId)
        }
      } catch (err) {
        session.reportError(err instanceof Error ? err.message : String(err))
        session.deps.clearTabPtyId(session.deps.tabId, attachPtyId)
        session.startFreshSpawn()
      }
    }
  } else {
    session.allowInitialIdleCacheSeed = false
    const pendingSpawn = pendingSpawnByPaneKey.get(session.pendingSpawnKey)
    if (pendingSpawn) {
      const pendingGeneration = pendingSpawnGenerationByPaneKey.get(session.pendingSpawnKey)
      if (pendingGeneration !== undefined && pendingGeneration !== session.tabGeneration) {
        recordPtyConnectDiagnostic(`pane=${session.pane.id} -> STALE PENDING SPAWN`)
        session.startFreshSpawn()
        scheduleRuntimeGraphSync()
        return
      }
      recordPtyConnectDiagnostic(`pane=${session.pane.id} -> PENDING SPAWN`)
      session.armDirectSshPaneRetryTimeout(pendingSpawn, session.directSshRetryAttempt)
      void pendingSpawn
        .then((spawnedPtyId) => {
          if (session.disposed) {
            return
          }
          if (session.transport.getPtyId()) {
            return
          }
          if (!spawnedPtyId) {
            // Why: React StrictMode can mount+spawn then immediately remount; if the first mount produced no PTY id,
            // the remounted pane must issue its own spawn instead of attaching to a completed-but-empty promise (a dead surface).
            if (!isWebTerminalSurfaceTabId(session.deps.tabId)) {
              console.warn(
                `Pending PTY spawn for tab ${session.deps.tabId} resolved without a PTY id, retrying fresh spawn`
              )
            }
            if (sleptRemoteColdRestoreStartup || hasSleepingAgentSession) {
              session.startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
            } else {
              session.startFreshSpawn()
            }
            return
          }
          if (!session.canAdoptCapturedDirectSshRetryPty(spawnedPtyId)) {
            return
          }
          session.clearPaneMode2031State()
          session.clearHiddenOutputRestoreState()
          const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
          session.transport.attach({
            existingPtyId: spawnedPtyId,
            cols: session.cols,
            rows: session.rows,
            callbacks: outputCallbacks.callbacks
          })
          const attachedPtyId = session.transport.getPtyId() ?? spawnedPtyId
          // Why: this reuses a PTY spawned by an earlier mount, so no later spawn event will bind this remounted pane's DOM/container.
          session.bindActivePanePty(attachedPtyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
        })
        .catch((err) => {
          session.reportError(err instanceof Error ? err.message : String(err))
        })
    } else {
      recordPtyConnectDiagnostic(`pane=${session.pane.id} -> FRESH SPAWN`)
      if (sleptRemoteColdRestoreStartup || hasSleepingAgentSession) {
        session.startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
      } else {
        session.startFreshSpawn()
      }
    }
  }
  scheduleRuntimeGraphSync()
}
