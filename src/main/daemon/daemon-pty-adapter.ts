import { acknowledgeDaemonWrite } from './daemon-accepted-write'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import { completeLaunchStage, endLaunchStageTrace } from '../observability/launch-stage-trace'
import { parseDaemonLaunchStageReport } from './session-launch-stage-report'
import { supportsMode2031UnsubscribeFact, type DaemonEvent } from './types'
import type { IPtyProvider } from '../providers/types'
import type {
  GuardedWriteOutcome,
  GuardedWriteReceiver,
  WriteFence
} from '../pty/guarded-pty-write'
import { createWriteLatch } from '../pty/terminal-write-latch'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import {
  PTY_LAUNCH_GATE_PROTOCOL_VERSION,
  PTY_LAUNCH_GATE_OBSERVATION_PROTOCOL_VERSION
} from './daemon-protocol-version'

export class DaemonPtyAdapter extends DaemonPtyDaemonRecovery implements IPtyProvider {
  supportsLaunchGate = (): boolean =>
    this.protocolVersion >= PTY_LAUNCH_GATE_PROTOCOL_VERSION &&
    (process.platform === 'darwin' || process.platform === 'linux')

  supportsLaunchGateObservation = (): boolean =>
    this.protocolVersion >= PTY_LAUNCH_GATE_OBSERVATION_PROTOCOL_VERSION &&
    process.platform === 'darwin'

  readLaunchGateObservation: NonNullable<IPtyProvider['readLaunchGateObservation']> = async (
    receipt
  ) => {
    if (!this.supportsLaunchGateObservation()) {
      throw new Error('pty_launch_gate_exit_observer_unavailable')
    }
    await this.ensureConnected()
    return this.client.request('readLaunchGateObservation', receipt)
  }

  releaseLaunchGate: NonNullable<IPtyProvider['releaseLaunchGate']> = async (request) => {
    if (!this.supportsLaunchGate()) {
      throw new Error('pty_launch_gate_unavailable')
    }
    // Release reconnects only to this owner; it must never respawn or reconstruct a gate.
    await this.ensureConnected()
    return this.client.request('releaseLaunchGate', request)
  }

  protected setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({
            id: event.sessionId,
            data: event.payload.data,
            ...((event.payload.rawLength ?? event.payload.sequenceChars) === undefined
              ? {}
              : { sequenceChars: event.payload.rawLength ?? event.payload.sequenceChars }),
            ...(event.payload.transformed ? { transformed: true } : {}),
            ...(event.payload.seq === undefined ? {} : { seq: event.payload.seq })
          })
        }
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          background: event.payload.background,
          ...(event.payload.scanSeedAnsi !== undefined
            ? { scanSeedAnsi: event.payload.scanSeedAnsi }
            : {}),
          ...(event.payload.mode2031PendingSubscribe
            ? { mode2031PendingSubscribe: true as const }
            : {})
        })
      } else if (event.event === 'launchStage') {
        // Diagnostics only: turn the daemon's stage report into a trace span. No
        // terminal signal, hook status or tui-idle read depends on this branch.
        // Parsed rather than trusted: the report crossed a process boundary.
        const report = parseDaemonLaunchStageReport(event.payload)
        if (report) {
          completeLaunchStage(event.sessionId, report.stage, {
            outcome: report.outcome,
            reportedElapsedMs: report.elapsedMs,
            ...(report.queuedWrites === undefined ? {} : { queuedWrites: report.queuedWrites })
          })
        }
      } else if (event.event === 'dataGap') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'dataGap',
          droppedChars: event.payload.droppedChars,
          ...(event.payload.sequenceChars === undefined
            ? {}
            : { sequenceChars: event.payload.sequenceChars })
        })
      } else if (event.event === 'transientFact') {
        // Why (#9993): a preserved pre-v29 daemon can retain a stale relay tracker. Its
        // unretractable subscribe is harmful; an unsubscribe is always safe to forward.
        if (
          event.payload.kind === '2031-subscribe' &&
          !supportsMode2031UnsubscribeFact(this.protocolVersion)
        ) {
          return
        }
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'transientFact',
          fact: event.payload
        })
      } else if (event.event === 'exit') {
        const pendingOperations = new Set([
          ...(this.pendingSpawnOperationsBySessionId.get(event.sessionId) ?? []),
          ...this.pendingClaimSpawnOperations
        ])
        for (const operation of pendingOperations) {
          if (operation.ignoreNextExit) {
            operation.ignoreNextExit = false
            continue
          }
          const exits = operation.exitsBySessionId.get(event.sessionId) ?? []
          exits.push(
            event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}
          )
          operation.exitsBySessionId.set(event.sessionId, exits)
        }
        const currentIncarnationId = this.sessionIncarnations.get(event.sessionId)
        if (
          event.payload.incarnationId &&
          currentIncarnationId &&
          event.payload.incarnationId !== currentIncarnationId
        ) {
          return
        }
        this.activeSessionIds.delete(event.sessionId)
        // Why here: a launch that exits before its last stage must not leave an
        // open span that would later be recorded as a whole-session-long stage.
        endLaunchStageTrace(event.sessionId)
        this.clearSessionAwaitingDaemonRecovery(event.sessionId)
        this.dirtySessionVersions.delete(event.sessionId)
        this.pausedProducerSessionIds.delete(event.sessionId)
        this.producerResumesOwedOnReconnect.delete(event.sessionId)
        this.backgroundedSessionIds.delete(event.sessionId)
        if (!this.sleepRestoreSessionIds.has(event.sessionId)) {
          this.coldRestoreCache.delete(event.sessionId)
        }
        this.sessionsNeedingFullCheckpoint.delete(event.sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(event.sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(event.sessionId)
        this.overlayDeadlineWarnedSessionIds.delete(event.sessionId)
        this.periodicDeadlineWarnedSessionIds.delete(event.sessionId)
        this.nonFinalAdmissionDeniedSessionIds.delete(event.sessionId)
        this.lastFullCheckpointAt.delete(event.sessionId)
        this.stopCheckpointTimerIfIdle()
        if (this.historyManager) {
          void this.historyManager
            .closeSession(event.sessionId, event.payload.code)
            .catch((err) => console.warn('[history] closeSession failed:', event.sessionId, err))
        }
        this.initialCwds.delete(event.sessionId)
        this.wslDistrosBySessionId.delete(event.sessionId)
        this.sessionIncarnations.delete(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.exitListeners]) {
          listener({
            id: event.sessionId,
            code: event.payload.code,
            ...(event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}),
            ...(event.payload.cause ? { cause: event.payload.cause } : {})
          })
        }
      }
    })
  }

  /** Its daemon predates conversation fences: no fenced write can go through it. */
  private writeFencesUnsupported = false

  /**
   * See `guarded-pty-write.ts`. The daemon checks the receiver and, for a fenced write, the fence
   * it was told of; a daemon that predates either cannot check, so it never writes.
   */
  writeAccepted: NonNullable<IPtyProvider['writeAccepted']> = (id, data, options) =>
    acknowledgeDaemonWrite(this.client, () => this.prepareWrite(id), id, data, options)

  async guardedWrite(
    id: string,
    data: string,
    receiver: GuardedWriteReceiver,
    fence?: WriteFence
  ): Promise<GuardedWriteOutcome> {
    if (fence?.isRevoked()) {
      return 'revoked'
    }
    if (fence && (process.platform === 'win32' || !fence.onClose || this.writeFencesUnsupported)) {
      return 'unsupported'
    }
    const { pid, pgid, startTimeMs } = receiver
    let latch: ReturnType<typeof createWriteLatch> | undefined
    let unsubscribe: (() => void) | undefined
    try {
      if (fence) {
        const daemonNonce = this.client.getDaemonIdentity()?.launchNonce
        if (!daemonNonce) {
          return 'unsupported'
        }
        latch = createWriteLatch(this.tokenPath, { daemonNonce, sessionId: id, receiver })
        unsubscribe = fence.onClose!(latch.close)
        if (fence.isRevoked()) {
          return 'revoked'
        }
      }
      const { outcome } = await this.client.request<{ outcome: GuardedWriteOutcome }>(
        latch ? 'latchedWrite' : 'fencedWrite',
        {
          sessionId: id,
          data,
          receiver: { pid, pgid, startTimeMs },
          ...(latch ? { latchToken: latch.token } : {})
        }
      )
      this.markSessionDirty(id)
      return outcome === 'written' ||
        outcome === 'unsupported' ||
        outcome === 'revoked' ||
        outcome === 'refused'
        ? outcome
        : 'unknown'
    } catch (error) {
      if (fence && isUnknownRequestTypeError(error)) {
        this.writeFencesUnsupported = true
      }
      return isUnknownRequestTypeError(error) ? 'unsupported' : 'unknown'
    } finally {
      latch?.close()
      unsubscribe?.()
    }
  }

  /** Main revoked a conversation fence; the daemon refuses every later write under it. */
  revokeWriteFence(token: string): void {
    void this.client.request('revokeWriteFence', { token }).catch((error: unknown) => {
      if (isUnknownRequestTypeError(error)) {
        this.writeFencesUnsupported = true
      }
    })
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    if (!this.supportsStartupIngress) {
      return 0
    }
    const result = await this.client.request<{ appliedSeq: number }>('closeStartupQueryAuthority', {
      sessionId: id
    })
    return result.appliedSeq
  }
}
