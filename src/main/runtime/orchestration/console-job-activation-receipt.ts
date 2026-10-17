import { z } from 'zod'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import type { OrchestrationDb } from './db/orchestration-db'

/**
 * Why: a console job binding on its own only proves shape. The receipt records
 * what the BFF actually handed back when the signed-in person activated the
 * approved job -- the job it issued, the activation intent it minted and the
 * digest of the graph that was approved. It is written once, by the main-only
 * console launch path, in the same INSERT as the binding; no RPC or CLI
 * parameter reaches it, so the execution fence can read it as evidence of Hub
 * admission instead of trusting a caller's request body.
 */
export const ConsoleJobActivationReceiptSchema = z.object({
  jobId: z.string().regex(/^job_[A-Za-z0-9_-]{1,128}$/),
  activationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/),
  jobDigest: z.string().regex(/^[a-f0-9]{64}$/)
})

export type ConsoleJobActivationReceipt = z.infer<typeof ConsoleJobActivationReceiptSchema>

/** Derive the receipt from the server's own activation response; never from request input. */
export function consoleJobActivationReceipt(
  binding: ConsoleJobBinding,
  jobDigest: string
): ConsoleJobActivationReceipt {
  const activationId = binding.claim?.attemptIntentId ?? binding.attemptId
  const parsed = ConsoleJobActivationReceiptSchema.safeParse({
    jobId: binding.jobId,
    activationId,
    jobDigest
  })
  if (!parsed.success) {
    throw new Error(
      'A console job activation requires the server-issued job, activation intent and approved digest.'
    )
  }
  return parsed.data
}

/** Reject a receipt that does not describe the binding it is stored beside. */
export function normalizeConsoleJobActivationReceipt(
  receipt: ConsoleJobActivationReceipt,
  binding: ConsoleJobBinding
): ConsoleJobActivationReceipt {
  const parsed = ConsoleJobActivationReceiptSchema.safeParse(receipt)
  if (!parsed.success || parsed.data.jobId !== binding.jobId) {
    throw new Error('The console job activation receipt must describe its own admitted job.')
  }
  return parsed.data
}

/**
 * The stored activation evidence for a Run, or null when the Run carries none.
 * A malformed row raises rather than degrading to "no admission was recorded".
 */
export function readConsoleJobActivationReceipt(
  db: OrchestrationDb,
  runId: string
): ConsoleJobActivationReceipt | null {
  const stored = db.getRun(runId)?.console_job_activation
  if (!stored) {
    return null
  }
  const parsed = ConsoleJobActivationReceiptSchema.safeParse(JSON.parse(stored))
  if (!parsed.success) {
    throw new Error('The stored console job activation receipt is not a server activation.')
  }
  return parsed.data
}
