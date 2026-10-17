import { z } from 'zod'

export const CAPACITY_RECOVERY_ENTRY_PREFIX = 'capacity-recovery:'

const identity = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.trim().length > 0)
const path = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.trim().length > 0)
const agent = z.enum(['claude', 'codex'])

const conversationSourceSchema = z
  .object({
    worktreeId: identity,
    paneKey: identity,
    kind: z.enum(['pty', 'structured']),
    sessionId: identity.optional()
  })
  .strict()
  .refine((value) => value.kind !== 'structured' || value.sessionId !== undefined)

/** A handoff receipt on the existing queue, not a second scheduler or work identity. */
export const conversationCapacityRecoverySchema = z
  .object({
    id: identity,
    sourceVersion: identity,
    sourceProcessIncarnation: identity,
    sourcePtyId: identity,
    sourceAgent: agent,
    sourceModel: identity.optional(),
    sourceProviderSessionId: identity,
    sourceTranscriptPath: path,
    historyPath: path.optional(),
    sourceAccountHome: path,
    sourceWorkspacePath: path.optional(),
    sourceViewMode: z.enum(['terminal', 'chat']).optional(),
    sourceFailedAt: z.number().finite().nonnegative(),
    sourceResetAt: z.number().finite().positive().optional(),
    detectedAt: z.number().finite().nonnegative(),
    phase: z.enum([
      'waiting-capacity',
      'prepared',
      'stopped',
      'created',
      'delivered',
      'held',
      'cancelled'
    ]),
    target: z
      .object({
        agent,
        accountHome: path,
        accountChoiceId: identity,
        model: identity.optional(),
        effort: identity.optional()
      })
      .strict()
      .optional(),
    successor: z
      .object({
        tabId: identity,
        leafId: identity,
        handle: identity,
        launchToken: identity,
        operationId: identity,
        source: conversationSourceSchema.optional()
      })
      .strict()
      .optional(),
    brief: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => value.trim().length > 0),
    reason: z.string().min(1).max(2_000).optional(),
    attemptAccounts: z.array(path).max(64)
  })
  .strict()
  .refine(
    (value) => {
      if (value.target && value.successor) {
        return true
      }
      return (
        !value.target &&
        !value.successor &&
        ['waiting-capacity', 'held', 'cancelled'].includes(value.phase)
      )
    },
    { message: 'An admitted capacity handoff requires its target and successor identities.' }
  )

export type ConversationCapacityRecovery = z.infer<typeof conversationCapacityRecoverySchema>
export type ConversationCapacityRecoveryTarget = NonNullable<ConversationCapacityRecovery['target']>
export type ConversationCapacityRecoverySuccessor = NonNullable<
  ConversationCapacityRecovery['successor']
>

export function normalizeConversationCapacityRecovery(
  value: unknown
): ConversationCapacityRecovery | null {
  const parsed = conversationCapacityRecoverySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
