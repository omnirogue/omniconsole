import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { readWorkerCompletionPolicy } from '../../shared/orchestration-worker-completion-policy'
import type { OrcaRuntimeService } from './omni-runtime'
import { inspectWorkerTerminal } from './rpc/methods/orchestration-worker-observation'

/**
 * A settled dispatch row proves the host gave up on a worker, not that its process exited: the
 * stall watchdog only writes rows, and a prompt whose submission went unverified may have landed.
 * Before a replacement starts, the old worker is resolved through its owned lifecycle,
 * so no second agent runs beside a quiet live one
 * (`sessionAttemptWorkerMayStillRun` says for which failures that can be).
 */
type WorkerLifecycleReceipt = { state?: string; processAction?: string; reason?: string }

/**
 * `stopped`: the old worker is proven gone and a replacement may start.
 * `pending`: the owned lifecycle holds a durable intent (unread mail, a protected pane, a
 * descendant still exiting); the next pass asks again and nothing is recorded against the attempt.
 * `unknown`: nobody can say whether the process exited; the attempt is held as unverifiable.
 */
export type SessionAttemptWorkerStop = 'stopped' | 'pending' | 'unknown'

/**
 * Missing inventory and a replaced pane do not prove the original process exited. Only the
 * execution owner's exact incarnation verdict or completed owned cleanup permits replacement.
 */
export async function stopSessionAttemptWorker(
  runtime: OrcaRuntimeService,
  attempt: Pick<SessionOutcomeAttempt, 'dispatchId'>
): Promise<SessionAttemptWorkerStop> {
  const dispatchId = attempt.dispatchId
  if (!dispatchId) {
    return 'unknown'
  }
  try {
    const db = runtime.getOrchestrationDb()
    // A remote worker's process is only reachable through its own host's stop.
    if (db.getFederatedDispatch(dispatchId)) {
      const receipt = await callWorkerLifecycle(runtime, dispatchId, 'orchestration.workerStop')
      return stopReceiptOutcome(receipt)
    }
    const observed = await inspectWorkerTerminal(runtime, db, dispatchId)
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    if (['unattached', 'missing', 'exited', 'identity_changed'].includes(observed.status)) {
      const dispatch = db.getDispatchContextById(dispatchId)
      const saved = resource ?? db.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
      if (
        !dispatch?.process_incarnation ||
        saved?.process_incarnation !== dispatch.process_incarnation ||
        !saved.host_scope ||
        (await runtime.inspectTerminalProcessIncarnationLiveness(
          dispatch.process_incarnation,
          saved.host_scope
        )) !== 'exited'
      ) {
        return 'unknown'
      }
      // A captured tree may outlive the PTY; the release owner must settle it before retry.
      if (
        resource &&
        resource.release_state !== 'released' &&
        db.getWorkerTerminalArchive(dispatchId)
      ) {
        const retained = retainedResourceOutcome(resource)
        if (retained) {
          return retained
        }
        const receipt = await callWorkerLifecycle(
          runtime,
          dispatchId,
          'orchestration.workerRelease'
        )
        return releaseReceiptOutcome(receipt)
      }
      return 'stopped'
    }
    const worker = db.getWorkerDispatch(dispatchId)
    if (
      observed.status !== 'live' ||
      !worker?.agent_terminal_handle ||
      !readWorkerCompletionPolicy(worker.start_options) ||
      !resource
    ) {
      return 'unknown'
    }
    const retained = retainedResourceOutcome(resource)
    if (retained) {
      return retained
    }
    // Stop intentionally leaves already-settled rows alone. Release preserves their output and
    // resumes captured descendant cleanup; a pending/protected receipt never permits a retry.
    const settled =
      worker.state === 'failed' ||
      worker.state === 'succeeded' ||
      (resource.release_state === 'retained' && resource.retained_reason === 'protection_held')
    const receipt = await callWorkerLifecycle(
      runtime,
      dispatchId,
      settled ? 'orchestration.workerRelease' : 'orchestration.workerStop'
    )
    return settled ? releaseReceiptOutcome(receipt) : stopReceiptOutcome(receipt)
  } catch (error) {
    // Why: the owned lifecycle call failing to answer is not a verdict about the process. The next
    // pass asks again; only an exact answer may settle or poison the attempt.
    console.warn('[outcomes] could not confirm the old worker stopped', dispatchId, error)
    return 'pending'
  }
}

type OwnedResource = {
  ownership_state: string
  release_state: string
  retained_reason: string | null
}

// A resource outside the owned lifecycle, or kept for a reason the owner cannot lift, is final.
function retainedResourceOutcome(resource: OwnedResource): SessionAttemptWorkerStop | null {
  if (resource.ownership_state !== 'owned') {
    return 'unknown'
  }
  if (resource.release_state !== 'retained') {
    return null
  }
  return resource.retained_reason === 'protection_held'
    ? null
    : retainedReasonOutcome(resource.retained_reason)
}

// A protection or an open obligation can lift on its own; identity doubt and legacy rows cannot.
function retainedReasonOutcome(reason: string | null | undefined): SessionAttemptWorkerStop | null {
  if (reason === 'pending_obligations') {
    return null
  }
  return reason === 'protection_held' ? 'pending' : 'unknown'
}

function releaseReceiptOutcome(receipt: WorkerLifecycleReceipt): SessionAttemptWorkerStop {
  switch (receipt.state) {
    case 'released':
    case 'already_released':
      return 'stopped'
    case 'release_pending':
      return 'pending'
    case 'retained':
      return retainedReasonOutcome(receipt.reason) ?? 'pending'
    case undefined:
      return 'unknown'
    default:
      return 'unknown'
  }
}

function stopReceiptOutcome(receipt: WorkerLifecycleReceipt): SessionAttemptWorkerStop {
  switch (receipt.state) {
    case 'stopped':
      return 'stopped'
    case 'stop_requested':
    case 'stopping':
      return 'pending'
    case undefined:
      return 'unknown'
    default:
      return 'unknown'
  }
}

async function callWorkerLifecycle(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  method: 'orchestration.workerStop' | 'orchestration.workerRelease'
): Promise<WorkerLifecycleReceipt> {
  // The RPC registry imports the outcome service; defer this import to avoid that module cycle.
  const { createOrchestrationCaller } = await import('./build-review/build-review-rpc-call')
  return createOrchestrationCaller(runtime)<WorkerLifecycleReceipt>(method, {
    dispatch: dispatchId
  })
}
