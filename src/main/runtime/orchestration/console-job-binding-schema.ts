import { z } from 'zod'
import { HUB_TASK_ID_PATTERN } from '../../../shared/omnios-task-binding'

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
const claimIdentifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/)

export const ConsoleJobBindingSchema = z
  .object({
    taskId: z.string().regex(HUB_TASK_ID_PATTERN),
    workflowId: identifier,
    jobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,128}$/),
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    leaseGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    claim: z
      .object({
        host: claimIdentifier,
        claimedAt: z.string().max(128).datetime({ offset: true }),
        runnerInstance: claimIdentifier,
        claimRequestId: claimIdentifier,
        attemptIntentId: claimIdentifier,
        dispatchKey: claimIdentifier
      })
      .optional(),
    sessionId: z
      .string()
      .regex(/^ses_[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    attemptId: identifier.optional(),
    contractId: identifier.optional(),
    contractDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    contractGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .refine(
    (binding) =>
      (binding.sessionId !== undefined) === (binding.attemptId !== undefined) &&
      (binding.claim !== undefined || binding.sessionId !== undefined),
    'A console job requires its complete activation claim or legacy session and attempt IDs.'
  )
