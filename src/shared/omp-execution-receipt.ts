import { z } from 'zod'
import { openrouterCandidates, openrouterApiId } from './openrouter-route'

export const ompExecutionReceipt = z
  .object({
    provider: z.literal('omp'),
    model: z.string().startsWith('openrouter/'),
    machine: z.string().min(1),
    requested_provider: z.literal('openrouter'),
    requested_model: openrouterApiId,
    openrouter_candidates: openrouterCandidates.optional(),
    effective_provider: z.literal('openrouter'),
    effective_model: openrouterApiId,
    model_attempts: z
      .array(
        z.object({
          provider: z.literal('openrouter'),
          model: openrouterApiId,
          stop_reason: z.string().min(1)
        })
      )
      .min(1)
      .max(10000),
    session_id: z.string().min(1)
  })
  .strict()
export type OmpExecutionReceipt = z.infer<typeof ompExecutionReceipt>
