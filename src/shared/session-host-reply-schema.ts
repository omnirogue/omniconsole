// Client-side readers for `sessionHost.*` replies. Lenient (Rule 1): unknown fields are dropped, an
// unreadable row is dropped rather than trusted, and every unknown value degrades to the reading
// that asserts least: verdict `unverifiable`, operation `unconfirmed`, admission not open.

import { z } from 'zod'
import {
  SESSION_HOST_RESERVATION_STATES,
  isSessionHostOperationId,
  type SessionHostReservationState
} from './session-host-identity'
import { sessionHostConversationIdSchema, sessionHostIdSchema } from './session-host-payload-schema'
import {
  SESSION_HOST_OPERATION_STATES,
  type SessionHostAdmissionStatus,
  type SessionHostOperationState
} from './session-host-protocol'
import type { SessionHostReceivedRefusal } from './session-host-refusal'
import { isSessionExecutionVerdict, type SessionExecutionVerdict } from './session-host-verdict'

function oneOf<T extends string>(known: readonly T[], fallback: T) {
  const set = new Set<string>(known)
  return z
    .unknown()
    .transform((value): T =>
      typeof value === 'string' && set.has(value) ? (value as T) : fallback
    )
}

const verdictRead = z
  .unknown()
  .transform((value): SessionExecutionVerdict =>
    isSessionExecutionVerdict(value) ? value : 'unverifiable'
  )
const operationStateRead = oneOf<SessionHostOperationState>(
  SESSION_HOST_OPERATION_STATES,
  'unconfirmed'
)
const reservationStateRead = oneOf<SessionHostReservationState>(
  SESSION_HOST_RESERVATION_STATES,
  'unconfirmed'
)
const ADMISSIONS: SessionHostAdmissionStatus[] = [
  'open',
  'reserved',
  'reconciling',
  'disabled',
  'not-adopted'
]
const admissionRead = oneOf<SessionHostAdmissionStatus>(ADMISSIONS, 'disabled')
const operationId = z.string().refine(isSessionHostOperationId)
const identity = z.object({ hostId: sessionHostIdSchema, incarnation: z.string().min(1).max(128) })

export const SessionHostRefusalReadSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(4000),
  capability: z.string().max(200).optional(),
  current: z
    .object({
      hostId: z.string().optional(),
      ownerEpoch: z.number().optional(),
      turnRevision: z.string().nullable().optional(),
      organizationRevision: z.string().optional(),
      operationId: z.string().optional()
    })
    .optional()
}) satisfies z.ZodType<SessionHostReceivedRefusal>

export const SessionHostOperationReadSchema = z.object({
  operationId,
  conversationId: sessionHostConversationIdSchema,
  /** A newer host's action this build does not know stays a string. */
  action: z.string().min(1).max(100),
  state: operationStateRead,
  fingerprint: z.string().min(1).max(200),
  host: identity,
  ownerEpoch: z.number().int().min(1),
  turnRevision: z.string().nullable(),
  admittedAt: z.number().optional(),
  settledAt: z.number().optional(),
  refusal: SessionHostRefusalReadSchema.optional(),
  result: z.unknown().optional(),
  verdict: verdictRead.optional()
})
export type SessionHostReceivedOperation = z.infer<typeof SessionHostOperationReadSchema>

export const SessionHostObservationReadSchema = z.object({
  conversationId: sessionHostConversationIdSchema,
  ownerEpoch: z.number().int().min(1),
  turnRevision: z.string().nullable(),
  organizationRevision: z.string().optional(),
  verdict: verdictRead,
  admission: admissionRead,
  reservation: z
    .object({ operationId, action: z.string(), state: reservationStateRead })
    .optional(),
  provider: z.object({ agent: z.string(), sessionId: z.string() }).nullable(),
  ref: z.object({
    hostId: sessionHostIdSchema,
    conversationId: sessionHostConversationIdSchema,
    paneKey: z.string().nullable(),
    tabId: z.string().nullable(),
    worktreePath: z.string().nullable()
  }),
  /** The host's presentation projection; readers validate the fields they render. */
  entry: z.record(z.string(), z.unknown()).optional()
})
export type SessionHostReceivedObservation = z.infer<typeof SessionHostObservationReadSchema>

const refused = z.object({ status: z.literal('refused'), refusal: SessionHostRefusalReadSchema })

/** A row that does not parse is dropped and the listing marked incomplete, never trusted. */
export const SessionHostObserveReplySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      host: identity,
      observedAt: z.number(),
      complete: z.boolean(),
      sessions: z.array(z.unknown()).max(10_000)
    })
    .transform((reply) => {
      const sessions = reply.sessions.flatMap((row) => {
        const parsed = SessionHostObservationReadSchema.safeParse(row)
        return parsed.success ? [parsed.data] : []
      })
      return {
        ...reply,
        sessions,
        complete: reply.complete && sessions.length === reply.sessions.length
      }
    }),
  refused
])

export const SessionHostExecuteReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), operation: SessionHostOperationReadSchema }),
  refused
])

export const SessionHostOperationReplySchema = z.union([
  z.object({
    status: z.literal('ok'),
    found: z.literal(true),
    operation: SessionHostOperationReadSchema
  }),
  z.object({ status: z.literal('ok'), found: z.literal(false), host: identity }),
  refused
])

export const SessionHostWaitStatusReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receipt: z.object({
      registration: operationId,
      dependency: sessionHostConversationIdSchema,
      // Why `registered` as the fallback: an unknown state never reads as satisfied.
      state: oneOf(['registered', 'satisfied', 'cancelled', 'ended-unmet'] as const, 'registered'),
      satisfiedBy: z
        .object({
          ownerEpoch: z.number().int().min(1),
          outcomeRevision: z.string(),
          at: z.number()
        })
        .optional()
    })
  }),
  refused
])

/**
 * An unreadable reply is the host's failure to answer, not an answer: the caller treats it like a
 * lost reply (verdict `unverifiable`, retry rule `repeat-same-operation`).
 */
export function readSessionHostReply<T>(
  schema: z.ZodType<T>,
  raw: unknown
): { ok: true; reply: T } | { ok: false; refusal: SessionHostReceivedRefusal } {
  const parsed = schema.safeParse(raw)
  return parsed.success
    ? { ok: true, reply: parsed.data }
    : {
        ok: false,
        refusal: {
          code: 'host-unreachable',
          message:
            'That computer answered with something this OmniConsole cannot read, so the outcome is unknown. It is not resent.'
        }
      }
}
