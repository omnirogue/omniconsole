export type ConsoleJobClaim = {
  host: string
  claimedAt: string
  runnerInstance: string
  claimRequestId: string
  attemptIntentId: string
  dispatchKey: string
}

/** The activation claim precedes the hub IDs returned by started; neither is IDE-generated. */
export type ConsoleJobBinding = {
  taskId: string
  workflowId: string
  jobId: string
  attempt: number
  leaseGeneration: number
  claim?: ConsoleJobClaim
  sessionId?: string
  attemptId?: string
  contractId?: string
  contractDigest?: string
  contractGeneration?: number
  inputDigest?: string
}
export type ConsoleExecutionObservation = {
  binding: ConsoleJobBinding
  journalCursor: string
  idempotencyKey: string
  event: 'run_started' | 'checkpoint_written' | 'stop_confirmed' | 'worker_exit'
  detail?: string
}
export type ConsoleExecutionAck = { eventId: string; journalCursor: string; idempotencyKey: string }
