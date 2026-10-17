/**
 * `sessionHost.hostStats`: one computer's resources as it reads them itself — its own
 * `collectHostMemory()` (free and total memory, cores, 1-minute load) plus how many of the
 * conversations it runs are live. Read-only: never admitted, never journaled, no origin. Negotiated
 * as `session-control.host-stats.v1`; an older host answers `unsupported-capability` and the
 * requesting Mac shows a dash, never a guess.
 */

import { z } from 'zod'
import type { HostMemory } from './process-stats-types'
import type { SessionHostIdentity } from './session-host-identity'
import { sessionHostIdSchema } from './session-host-payload-schema'
import type { SessionHostRefusal } from './session-host-refusal'
import { SessionHostRefusalReadSchema } from './session-host-reply-schema'

/** No parameters today; strict so a newer client's field is refused, not silently ignored. */
export type SessionHostStatsParams = Record<string, never>
export const SessionHostStatsParamsSchema = z.object({}).strict()

export type SessionHostStats = {
  host: SessionHostIdentity
  /** Epoch ms on the answering host's clock. */
  observedAt: number
  memory: Pick<HostMemory, 'totalMemory' | 'availableMemory' | 'cpuCoreCount' | 'loadAverage1m'>
  /** Registered conversations whose verdict is `live`; null when the host could not observe them. */
  liveSessions: number | null
}

export type SessionHostStatsResult =
  | ({ status: 'ok' } & SessionHostStats)
  | { status: 'refused'; refusal: SessionHostRefusal }

const nonNegative = z.number().finite().nonnegative()

/** Client-side reader: lenient on extra fields, strict on the numbers it shows. */
export const SessionHostStatsReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    host: z.object({ hostId: sessionHostIdSchema, incarnation: z.string().min(1).max(128) }),
    observedAt: nonNegative,
    memory: z.object({
      totalMemory: nonNegative,
      availableMemory: nonNegative,
      cpuCoreCount: z.number().int().min(1).max(100_000),
      loadAverage1m: nonNegative
    }),
    liveSessions: z.number().int().nonnegative().nullable()
  }),
  z.object({ status: z.literal('refused'), refusal: SessionHostRefusalReadSchema })
])
