import { z } from 'zod'
export const ROUTINE_DELIVERY_UNCONFIRMED =
  'Delivery outcome not confirmed. This attempt will not be repeated automatically.'
export const routineDeliveryPhase = z.enum(['execution', 'alerts'])
export type RoutineDeliveryPhase = z.infer<typeof routineDeliveryPhase>
export type RoutineDeliveryClaims = Partial<Record<RoutineDeliveryPhase, string>>
export const routineDeliveryResultSchema = z.object({
  kind: z.enum([
    'chat',
    'slack',
    'google-drive',
    'file',
    'hub-card',
    'desktop',
    'slack-dm',
    'slack-channel',
    'email'
  ]),
  target: z.string().max(4096),
  ok: z.boolean(),
  error: z.string().max(4096).optional(),
  permalink: z.string().max(4096).optional()
})
export const routineDeliveryWriteSchema = z.object({
  automationId: z.string().min(1),
  runId: z.string().min(1),
  phase: routineDeliveryPhase,
  claimId: z.string().uuid(),
  results: routineDeliveryResultSchema.array().max(100).optional()
})
export type RoutineDeliveryWrite = z.infer<typeof routineDeliveryWriteSchema>
