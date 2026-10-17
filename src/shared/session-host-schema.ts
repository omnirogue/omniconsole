// Host-side request schemas for `sessionHost.*`. Strict: an unknown key is refused, so a field this
// host does not understand can never be silently dropped from a mutation (docs/reference/
// remote-wire-compatibility.md). Anything newer is negotiated as a capability first.

import { z } from 'zod'
import { isSessionHostRevision } from './session-host-identity'
import {
  SESSION_HOST_PAYLOAD_SCHEMAS,
  sessionHostConversationIdSchema,
  sessionHostOperationIdSchema,
  sessionHostOwnerEpochSchema
} from './session-host-payload-schema'
import { SESSION_HOST_ACTIONS, type SessionHostRequest } from './session-host-protocol'

const text = (max: number) => z.string().trim().min(1).max(max)

export const sessionHostRevisionSchema = z
  .string()
  .refine(isSessionHostRevision, 'A revision is 1-256 printable characters the host returned.')

export const SessionHostUnattendedSchema = z
  .object({
    source: z.enum(['rules', 'cleanup-run']),
    runId: text(200).optional(),
    since: z.number().int().min(0).optional()
  })
  .strict()

// Why `via` is a bounded string, not an enum: a newer client's surface name must not make an
// older host's strict schema refuse the whole request. It is audited, never trusted for policy.
export const SessionHostOriginSchema = z
  .object({
    computer: text(80),
    requester: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('person'), via: text(40) }).strict(),
      z
        .object({
          kind: z.literal('pane'),
          paneKey: text(1000),
          title: z.string().max(1000),
          unattended: SessionHostUnattendedSchema.optional()
        })
        .strict(),
      z
        .object({ kind: z.literal('cli'), unattended: SessionHostUnattendedSchema.optional() })
        .strict()
    ]),
    request: text(4000).optional(),
    reason: text(1000).optional()
  })
  .strict()

const SessionHostEnvelopeSchema = z
  .object({
    operationId: sessionHostOperationIdSchema,
    conversationId: sessionHostConversationIdSchema,
    expectedOwnerEpoch: sessionHostOwnerEpochSchema,
    expectedTurnRevision: sessionHostRevisionSchema.nullable(),
    expectedOrganizationRevision: sessionHostRevisionSchema.optional(),
    reservation: sessionHostOperationIdSchema.optional(),
    origin: SessionHostOriginSchema,
    action: z.enum(SESSION_HOST_ACTIONS),
    payload: z.unknown()
  })
  .strict()

/** `sessionHost.execute` and `sessionHost.reserve`: the envelope, then the action's own payload. */
export const SessionHostRequestSchema = SessionHostEnvelopeSchema.transform(
  (request, ctx): SessionHostRequest => {
    const payload = SESSION_HOST_PAYLOAD_SCHEMAS[request.action].safeParse(request.payload)
    if (!payload.success) {
      for (const issue of payload.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: [
            'payload',
            ...issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part))
          ]
        })
      }
      return z.NEVER
    }
    // Why the cast: zod cannot correlate `action` with its payload schema across the union.
    return { ...request, payload: payload.data } as SessionHostRequest
  }
)

export const SessionHostObserveParamsSchema = z
  .object({
    conversationIds: z.array(sessionHostConversationIdSchema).max(500).optional(),
    includeArchived: z.boolean().optional()
  })
  .strict()

export const SessionHostOperationParamsSchema = z
  .object({
    operationId: sessionHostOperationIdSchema,
    conversationId: sessionHostConversationIdSchema
  })
  .strict()

export const SessionHostReleaseParamsSchema = z
  .object({
    operationId: sessionHostOperationIdSchema,
    conversationId: sessionHostConversationIdSchema,
    reservation: sessionHostOperationIdSchema,
    origin: SessionHostOriginSchema
  })
  .strict()

export const SessionHostTidyParamsSchema = z
  .object({
    operationId: sessionHostOperationIdSchema,
    apply: z.boolean().optional(),
    include: z.array(sessionHostConversationIdSchema).max(200).optional(),
    origin: SessionHostOriginSchema
  })
  .strict()

export const SessionHostHistoryParamsSchema = z
  .object({
    conversationId: sessionHostConversationIdSchema,
    limit: z.number().int().min(1).max(200).optional()
  })
  .strict()

export const SessionHostWaitStatusParamsSchema = z
  .object({
    registration: sessionHostOperationIdSchema,
    dependency: sessionHostConversationIdSchema
  })
  .strict()

/** Parses a request, answering a shape failure with the one refusal every transport can carry. */
export function parseSessionHostRequest(
  raw: unknown
): { ok: true; request: SessionHostRequest } | { ok: false; message: string } {
  const parsed = SessionHostRequestSchema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, request: parsed.data }
  }
  const first = parsed.error.issues[0]
  const where = first?.path.length ? `${first.path.map(String).join('.')}: ` : ''
  return {
    ok: false,
    message: `The request was refused as malformed (${where}${first?.message ?? 'invalid'}). Nothing was changed.`
  }
}
