import { z } from 'zod'
import { jiraTaskId } from './console-jira-session-contract'
import { LEDGER_ID_PATTERN } from './session-ledger-contract'

export const taskSessionId = z.union([
  z.string().regex(/^ses_[A-Za-z0-9]{4,64}$/),
  z.string().regex(LEDGER_ID_PATTERN)
])

export const sessionTaskContextRequest = z
  .object({
    taskId: z.union([z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/), jiraTaskId]),
    sessionId: taskSessionId.optional(),
    sourceKey: z.string().trim().min(1).max(400).optional()
  })
  .strict()
  .refine((value) => Boolean(value.sessionId || value.sourceKey))

export type ConsoleSessionTaskContextRequest = z.infer<typeof sessionTaskContextRequest>
