import { OrchestrationError } from '../../orchestration/orchestration-error'

type StopSnapshot = { state: string; last_error: string | null }

export function settledWorkerStopReceipt(dispatchId: string, state: string) {
  return { dispatchId, state, alreadySettled: true, processAction: 'none' }
}

export function unknownWorkerStopReceipt(
  dispatchId: string,
  worker: StopSnapshot,
  processAction: string
) {
  return {
    dispatchId,
    state: worker.state,
    alreadySettled: false,
    processAction,
    lastError: worker.last_error
  }
}

export function interruptedWorkerStopReceipt(
  dispatchId: string,
  worker: StopSnapshot | null | undefined
) {
  if (worker?.state === 'stopping') {
    return null
  }
  if (worker?.state === 'stop_unknown') {
    return unknownWorkerStopReceipt(dispatchId, worker, 'unknown')
  }
  if (worker && ['stopped', 'succeeded', 'failed', 'abandoned'].includes(worker.state)) {
    return settledWorkerStopReceipt(dispatchId, worker.state)
  }
  throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
}

export function workerStopErrorReceipt(
  dispatchId: string,
  error: unknown,
  readWorker: () => StopSnapshot | null | undefined,
  markUnknown: (reason: string) => StopSnapshot
) {
  try {
    const interrupted = interruptedWorkerStopReceipt(dispatchId, readWorker())
    if (interrupted) {
      return interrupted
    }
    const reason = error instanceof Error ? error.message : String(error)
    return unknownWorkerStopReceipt(dispatchId, markUnknown(reason), 'unknown')
  } catch {
    // A failed receipt write must not hide the original stop error.
    throw error
  }
}
