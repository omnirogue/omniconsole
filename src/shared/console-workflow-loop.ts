import { z } from 'zod'

const participantText = z.string().trim().min(1).max(128)

/** The closed loop vocabulary: the IDE's work plans and the hub's cards share exactly this. */
export const consoleWorkflowLoopKind = z.enum(['gap', 'review', 'adversarial'])
export const consoleWorkflowLoopStopRule = z.enum([
  'all_gaps_closed',
  'zero_blockers',
  'max_rounds'
])
export const CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS = 5

export const consoleWorkflowLoop = z
  .object({
    kind: consoleWorkflowLoopKind,
    participants: z.array(participantText).min(2).max(6),
    participant_ids: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/))
      .min(2)
      .max(6)
      .optional(),
    participant_efforts: z.record(participantText, participantText.nullable()).optional(),
    max_rounds: z.number().int().min(1).max(CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS),
    stop_rule: consoleWorkflowLoopStopRule
  })
  .strict()
  .refine(
    (value) =>
      !value.participant_ids ||
      (value.participant_ids.length === value.participants.length &&
        new Set(value.participant_ids).size === value.participant_ids.length),
    'Each loop participant requires one unique identity.'
  )
