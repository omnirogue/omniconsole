// Ported from omnirogue/omni-console console/src/features/estate/communication-api.ts
// at be9e0638 (2026-09-13); aligned with OmniRogue customerRooms.ts. No console transport.
import { z } from 'zod'

export const roomId = z.string().uuid()
export const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n)
const count = z.number().int().nonnegative()
const cursor = z.string().max(300)
export const room = z.object({
  id: roomId,
  tenantId: z.string(),
  name: z.string(),
  memberCount: count,
  status: z.string().optional(),
  role: z.enum(['host', 'member']).optional(),
  kind: z.enum(['room', 'direct']).optional()
})
export const roomAgent = z.object({
  id: roomId,
  ownerId: roomId,
  name: z.string(),
  available: z.boolean(),
  mode: z.enum(['manual', 'mentions']).optional(),
  repliesUsed: count.optional(),
  maxReplies: count.optional(),
  respondTo: z.enum(['owner-only', 'room-members', 'selected', 'paused']).optional(),
  allowUserIds: z.array(roomId).optional(),
  delivery: z.enum(['queue', 'owner-interrupt']).optional(),
  exposure: z.enum(['participant', 'transcript', 'live']).optional()
})
export const roomDetail = room.extend({
  currentUserId: roomId,
  code: z.string(),
  members: z.array(z.object({ userId: roomId, name: z.string(), role: z.string() })),
  membersNextCursor: cursor.nullish(),
  membersTruncated: z.boolean().optional(),
  agents: z.array(roomAgent)
})
const usage = z.object({
  tokensIn: count.optional(),
  tokensOut: count.optional(),
  cacheRead: count.optional(),
  cacheWrite: count.optional(),
  estCostUsd: z.number().nonnegative().max(1000).optional(),
  model: z.string().max(120).optional(),
  provider: z.string().max(60).optional()
})
export const roomEvent = z.object({
  eventId: roomId,
  sequence,
  senderId: z.string(),
  senderKind: z.enum(['human', 'bot', 'system']),
  senderName: z.string(),
  content: z.string().max(3000),
  createdAt: z.string().datetime(),
  // Future event kinds remain readable; older servers omit the kind on messages.
  eventKind: z.string().optional(),
  turnId: roomId.nullish(),
  mentionedUserIds: z.array(roomId).optional(),
  targetAgentIds: z.array(roomId).optional(),
  metadata: z
    .object({
      kind: z.string().optional(),
      toolName: z.string().optional(),
      targetAgentIds: z.array(roomId).optional(),
      turnId: roomId.optional(),
      resultEventId: roomId.optional(),
      executionReceipt: roomId.nullish(),
      replyToEventId: roomId.nullish(),
      usage: usage.optional()
    })
    .nullish()
})
export const roomList = z.object({ rooms: z.array(room), nextCursor: cursor.nullable() })
export const roomEvents = z.object({ events: z.array(roomEvent).max(100), nextCursor: sequence })
export const roomPending = z.object({
  rooms: z.array(
    z.object({
      roomId,
      recipientId: z.string(),
      consumedSequence: sequence,
      headSequence: sequence,
      pendingCount: count,
      mentionCount: count.optional()
    })
  ),
  agents: z.array(
    z.object({
      roomId,
      agentId: roomId,
      pendingCount: count,
      pendingTurns: count,
      gated: z.boolean().optional(),
      waitingForBudget: z.boolean(),
      waitingForConsent: z.boolean(),
      exposure: roomAgent.shape.exposure
    })
  ),
  nextCursor: roomId.nullable()
})
export const roomSend = z
  .object({
    eventId: roomId,
    content: z
      .string()
      .trim()
      .min(1)
      .max(3000)
      .refine((value) => new TextEncoder().encode(value).length <= 12000),
    mentionedUserIds: z.array(roomId).max(20),
    targetAgentIds: z.array(roomId).max(5),
    replyToEventId: roomId.optional()
  })
  .strict()
export const roomAck = z.object({ sequence }).strict()
export const roomSendReceipt = z.object({ sequence, replayed: z.boolean() })
export const roomAckReceipt = z.object({
  roomId,
  recipientId: z.string(),
  consumedSequence: sequence,
  replayed: z.boolean()
})
export const roomConnection = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.string().url(),
  expiresAt: z.number().int().positive()
})
