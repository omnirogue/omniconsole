import { z } from 'zod'
import { handoffId, handoffVersionId } from './console-handoff-contract'

const reaskPlan = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
  threadId: handoffId,
  note: z.string().min(1).max(8192),
  files: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1).max(255),
      baseVersionId: handoffVersionId.optional()
    })
  )
})

export type FollowUpReaskPlan = z.infer<typeof reaskPlan>

export function normalizeReaskPlan(value: unknown): FollowUpReaskPlan | undefined {
  const parsed = reaskPlan.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
