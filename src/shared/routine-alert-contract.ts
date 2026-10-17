import { z } from 'zod'
import type { RoutineRunLink } from './routine-run-link'

export const routineSlackStatusSchema = z.object({
  authenticated: z.boolean(),
  connection: z.object({ id: z.string(), title: z.string() }).nullable(),
  ownerEmail: z.string().optional(),
  error: z.string().optional()
})
export const routineSlackChannelSchema = z.object({ id: z.string(), name: z.string() })
export const routineSlackPayloadSchema = z.intersection(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('channel'), channel: z.string().trim().min(1).max(200) }),
    z.object({ kind: z.literal('dm'), email: z.string().email().max(320).optional() })
  ]),
  z.object({
    text: z.string().trim().min(1).max(28_000),
    runLink: z.string().trim().min(1).max(2048),
    runId: z.string().min(1).max(128),
    automationId: z.string().min(1).max(128),
    purpose: z.enum(['alert', 'output']).optional()
  })
)
export const routineSlackResultSchema = z.object({
  ok: z.boolean(),
  permalink: z.string().optional(),
  error: z.string().optional()
})
export type RoutineSlackStatus = z.infer<typeof routineSlackStatusSchema>
export type RoutineSlackChannel = z.infer<typeof routineSlackChannelSchema>
export type RoutineSlackPayload = z.infer<typeof routineSlackPayloadSchema>
export type RoutineSlackResult = z.infer<typeof routineSlackResultSchema>
export type RoutineAlertApi = {
  onOpenRun: (listener: (target: RoutineRunLink) => void) => () => void
  consumePendingOpenRun: () => Promise<RoutineRunLink | null>
  deliverRun: (input: {
    automationId: string
    runId: string
    environmentId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  slack: {
    status: () => Promise<RoutineSlackStatus>
    listChannels: (refresh?: boolean) => Promise<RoutineSlackChannel[]>
    send: (payload: RoutineSlackPayload) => Promise<RoutineSlackResult>
  }
}
