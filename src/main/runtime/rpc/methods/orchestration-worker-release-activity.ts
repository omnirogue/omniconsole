import type { OrcaRuntimeService } from '../../omni-runtime'
import { isEquivalentPaneKey } from '../../orchestration/db/pane-key-match'
import type { WorkerReleaseReceipt } from './orchestration-worker-release-receipt'

const activeByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<WorkerReleaseReceipt>>
>()
const closeIssuedByRuntime = new WeakMap<OrcaRuntimeService, Map<string, string>>()

export function runWorkerReleaseOnce(
  runtime: OrcaRuntimeService,
  resourceId: string,
  work: () => Promise<WorkerReleaseReceipt>
): Promise<WorkerReleaseReceipt> {
  let active = activeByRuntime.get(runtime)
  if (!active) {
    active = new Map()
    activeByRuntime.set(runtime, active)
  }
  const existing = active.get(resourceId)
  if (existing) {
    return existing
  }
  const release = work().finally(() => {
    if (active?.get(resourceId) === release) {
      active.delete(resourceId)
    }
  })
  active.set(resourceId, release)
  return release
}

export function markWorkerTerminalCloseIssued(
  runtime: OrcaRuntimeService,
  resourceId: string,
  paneKey: string | null
): () => void {
  let issued = closeIssuedByRuntime.get(runtime)
  if (!issued) {
    issued = new Map()
    closeIssuedByRuntime.set(runtime, issued)
  }
  issued.set(resourceId, paneKey ?? '')
  return () => issued.delete(resourceId)
}

export function workerTerminalCloseIssued(
  runtime: OrcaRuntimeService,
  resourceId: string
): boolean {
  return closeIssuedByRuntime.get(runtime)?.has(resourceId) ?? false
}

export function workerTerminalPaneCloseIssued(
  runtime: OrcaRuntimeService,
  paneKey: string
): boolean {
  return [...(closeIssuedByRuntime.get(runtime)?.values() ?? [])].some(
    (candidate) => candidate === paneKey || isEquivalentPaneKey(candidate, paneKey)
  )
}
