import { z } from 'zod'
import { isBoardTaskId } from './board-task-id'

const text = z.string().trim().min(1).max(32_000)

/**
 * The board card this outcome is filed under. A label on the pursuit, never an execution route:
 * admitted card execution is `continuation.taskId`, which this must never be confused with or
 * written into. Many outcomes may name one card, and an outcome may name none.
 */
export const sessionOutcomeTaskRefSchema = z
  .object({
    taskId: z.custom<string>(isBoardTaskId, 'A board card id looks like btk_….'),
    attachedAt: z.number().finite().nonnegative(),
    attachedBy: text.optional(),
    /** The typed note this attach posted to the card, so a re-attach does not post it twice. */
    postedNoteId: text.optional(),
    postedRevision: z.number().int().positive().optional(),
    postedAt: z.number().finite().nonnegative().optional()
  })
  .strict()
export type SessionOutcomeTaskRef = z.infer<typeof sessionOutcomeTaskRefSchema>
