import { z } from 'zod'

export const routineStructuredResultSchema = z
  .object({
    protocol: z.literal('routine-classification.v1'),
    routineId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    evaluatedAt: z.number().int().nonnegative(),
    status: z.enum(['ready', 'blocked']),
    reason: z.string().max(200).nullable(),
    verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']).nullable(),
    severity: z.enum(['INFO', 'WARNING', 'ERROR']).nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
    provider: z.string().max(96).nullable(),
    model: z.string().max(96).nullable()
  })
  .strict()

export type RoutineStructuredResult = z.infer<typeof routineStructuredResultSchema>
