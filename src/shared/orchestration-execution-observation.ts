export type OrchestrationExecutionObservation = {
  hubTaskId: string
  runId: string
  journalCursor: string
  event: 'run_started' | 'checkpoint_written' | 'stop_confirmed' | 'worker_exit'
  workerDispatchId?: string
  detail?: string
}

export type OrchestrationObservationInput = {
  runId: string
  event: OrchestrationExecutionObservation['event']
  workerDispatchId?: string
  checkpointCursor?: string
  detail?: string
}

export type OrchestrationObservationReporter = (
  observation: OrchestrationExecutionObservation
) => Promise<{ ok: true; noteId: string } | { ok: false; message: string }>
