import { z } from 'zod'

export type OutcomeAmendmentJobState = 'pending' | 'requested' | 'cancelled' | 'unverifiable'

export type OutcomeAmendmentAcceptedCompletion = {
  resultReceiptId: string
  resultFingerprint: string
  verificationReportId: string
}

export type OutcomeAmendmentCancellationReceipt = {
  outcome: 'cancelled' | 'completed' | 'failed'
  serverAcknowledged: true
  terminal: 'not_started' | 'stopped' | 'completed' | 'failed'
  observedState: 'cancelled' | 'completed' | 'failed'
  observedAt: number
  resultReceiptId?: string
  resultFingerprint?: string
  verificationReportId?: string
}

export type OutcomeAmendmentJob = {
  jobId: string
  workflowId: string
  approvedDigest: string
  taskId: string
  expectedAttempt: number | null
  expectedLeaseGeneration: number | null
  state: OutcomeAmendmentJobState
  dispatchId?: string
  runId?: string
  receipt?: OutcomeAmendmentCancellationReceipt
  error?: string
}

export type OutcomeAmendmentIntent = {
  id: string
  principal: string
  sourceOperationIds: string[]
  state: 'prepared' | 'reconciling' | 'ready' | 'blocked'
  jobs: OutcomeAmendmentJob[]
}

export type OutcomeAmendmentObservedJob = {
  jobId: string
  workflowId: string
  approvedDigest: string
  taskId: string
  state: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed' | 'unknown'
  attempt: number | null
  leaseGeneration: number | null
  dispatchId?: string
  runId?: string
  serverCancellationAcknowledged: boolean
  terminalStopped: boolean
  acceptedCompletion: OutcomeAmendmentAcceptedCompletion | null
  acceptedFailure?: { resultReceiptId: string; resultFingerprint: string } | null
}

export type OutcomeAmendmentCancellationPort = {
  readJob(jobId: string): Promise<OutcomeAmendmentObservedJob>
  cancelQueued(jobId: string): Promise<void>
  cancelRunning(job: OutcomeAmendmentObservedJob): Promise<void>
  now(): number
}

const text = z.string().min(1).max(32000)
export const outcomeAmendmentIntentSchema: z.ZodType<OutcomeAmendmentIntent> = z
  .object({
    id: text,
    principal: text,
    sourceOperationIds: z.array(text).max(32),
    state: z.enum(['prepared', 'reconciling', 'ready', 'blocked']),
    jobs: z
      .array(
        z
          .object({
            jobId: text,
            workflowId: text,
            approvedDigest: text,
            taskId: text,
            expectedAttempt: z.number().int().nonnegative().nullable(),
            expectedLeaseGeneration: z.number().int().nonnegative().nullable(),
            state: z.enum(['pending', 'requested', 'cancelled', 'unverifiable']),
            dispatchId: text.optional(),
            runId: text.optional(),
            error: text.optional(),
            receipt: z
              .object({
                outcome: z.enum(['cancelled', 'completed', 'failed']),
                serverAcknowledged: z.literal(true),
                terminal: z.enum(['not_started', 'stopped', 'completed', 'failed']),
                observedState: z.enum(['cancelled', 'completed', 'failed']),
                observedAt: z.number().finite(),
                resultReceiptId: text.optional(),
                resultFingerprint: text.optional(),
                verificationReportId: text.optional()
              })
              .strict()
              .optional()
          })
          .strict()
      )
      .max(2048)
  })
  .strict()
