import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { markWorkerTerminalCloseIssued } from './orchestration-worker-release-activity'
import type { WorkerReleaseReceipt } from './orchestration-worker-release-receipt'

// Closes the exact worker terminal once its close phase is persisted. Returns the receipt that
// stops the release (unknown or pending) or null when the PTY is confirmed gone.
export async function closeWorkerTerminalForRelease(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  archive: { source: string | null; status: string | null }
): Promise<WorkerReleaseReceipt | null> {
  const closeCompleted = markWorkerTerminalCloseIssued(runtime, resource.id, resource.pane_key)
  try {
    const close = await runtime.closeTerminal(resource.terminal_handle)
    if (!close.ptyKilled) {
      const reason = describeUnconfirmedAgentStop(close)
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
      return {
        dispatchId,
        state: 'release_unknown',
        processAction: 'closed_agent_terminal',
        archive,
        lastError: unknown.release_error ?? reason,
        recovery: `Inspect with: omni orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/disposed|not connected|unavailable/i.test(reason)) {
      // Durable intent exists; the owning endpoint is temporarily unreachable. Recovery retries.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive,
        lastError: reason,
        recovery:
          'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive,
      lastError: unknown.release_error ?? reason,
      recovery: `Inspect with: omni orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  } finally {
    closeCompleted()
  }
  return null
}
