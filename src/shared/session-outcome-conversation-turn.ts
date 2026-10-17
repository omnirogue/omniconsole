/**
 * The receipt an attempt carries when it is a TURN of the original conversation rather than a
 * worker of its own (WP-4b).
 *
 * It is the producer's conversation handle plus the three things a delivery needs to be safe: the
 * idempotency key both send doors already honour, the host epoch that minted it — a key under a
 * foreign epoch is a send whose result this process cannot know — and the identity of the ending
 * the delivery was sent AFTER, so the NEXT ending is what settles the step. `reportPath` is where
 * that turn's output was written, exactly as a worker's report is read from its Task.
 *
 * Its own file because the attempt schema is at the 300-line budget and because this shape is
 * shared by the executor, the settlement and anything that has to read a continued step back.
 */

import { z } from 'zod'
import type { ConversationSource } from './conversation-source'

const text = z.string().trim().min(1).max(32_000)
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const sessionOutcomeConversationTurnSchema = z
  .object({
    worktreeId: text,
    paneKey: text,
    kind: z.enum(['pty', 'structured']),
    /** Present on a chat conversation: the session its pane key was minted from. */
    sessionId: text.optional(),
    operationId: text.optional(),
    epoch: id.optional(),
    turnVersion: text.optional(),
    deliveredAt: z.number().finite().nonnegative().optional(),
    reportPath: text.optional()
  })
  .strict()

export type SessionOutcomeConversationTurn = z.infer<typeof sessionOutcomeConversationTurnSchema>

/** The address half of the receipt, in the shape every conversation primitive takes. */
export function sessionOutcomeConversationSource(
  turn: SessionOutcomeConversationTurn
): ConversationSource {
  return {
    worktreeId: turn.worktreeId,
    paneKey: turn.paneKey,
    kind: turn.kind,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {})
  }
}
