import type { OrcaRuntimeService } from '../omni-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'

const RETRY_INTERVAL_MS = 10_000
const lastRetryByRuntime = new WeakMap<OrcaRuntimeService, number>()

/** The existing host tick retries durable intent, without keeping an extra timer or session. */
export function retryRequestedWorkerTerminalReleases(
  runtime: OrcaRuntimeService,
  nowMs = Date.now()
): void {
  const last = lastRetryByRuntime.get(runtime)
  if (last !== undefined && nowMs >= last && nowMs - last < RETRY_INTERVAL_MS) {
    return
  }
  lastRetryByRuntime.set(runtime, nowMs)
  try {
    // The DB may not be ready during startup. The reconciler also repairs exact legacy holds.
    runtime.getOrchestrationDb()
  } catch {
    return
  }
  void reconcileRequestedWorkerTerminalReleases(runtime).catch((error) => {
    console.warn('[orchestration] worker terminal release retry failed', { error })
  })
}
