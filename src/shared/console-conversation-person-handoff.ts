import { z } from 'zod'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import {
  consoleConversationSourceFile,
  consoleConversationSourcePath
} from './console-conversation-source-files'

export const CONVERSATION_PERSON_HANDOFF_ACTOR = 'stop_rule:person_handoff'
const employeeId = z.string().regex(/^emp_[a-z0-9_-]{1,80}$/)
const deliverables = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('files'), paths: z.array(consoleConversationSourcePath).max(32) })
    .strict(),
  z.object({ kind: z.literal('manifest'), manifestPath: consoleConversationSourcePath }).strict(),
  z
    .object({
      kind: z.literal('manifests'),
      manifestPaths: z.array(consoleConversationSourcePath).min(1).max(32)
    })
    .strict(),
  // The session's own transcript, redacted and attached as a file. `include`
  // is the owner's recorded consent: this deliverable exists only because a
  // person ticked it, so the request carries the decision, not just the file.
  z.object({ kind: z.literal('transcript'), include: z.literal(true) }).strict()
])

/** Where the transcript lands in the recipient's payload. */
export const CONVERSATION_TRANSCRIPT_TARGET_PATH = 'handoff/transcript.md'

export const conversationPersonHandoffRequest = z
  .object({
    version: z.literal(1),
    approved: z.literal(true),
    recipient_employee_id: employeeId,
    task_id: z.string().regex(BOARD_TASK_ID_PATTERN).nullable(),
    action: z.enum(['review', 'approve', 'decide', 'edit', 'fyi']).optional(),
    note: z
      .string()
      .max(8192)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 8192),
    include_summary: z.boolean(),
    deliverables,
    due_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/)
      .optional(),
    source_files: z.array(consoleConversationSourceFile).max(32).optional(),
    summary_file: consoleConversationSourceFile.optional()
  })
  .strict()

const participant = z
  .object({ employee_id: employeeId, clerk_user_id: z.string().min(1).max(256) })
  .strict()
export const conversationPersonHandoff = conversationPersonHandoffRequest
  .extend({
    participants: z.object({ director: participant, recipient: participant }).strict(),
    source_files: z.array(consoleConversationSourceFile).max(32)
  })
  .strict()

export type ConsoleConversationPersonHandoffRequest = z.infer<
  typeof conversationPersonHandoffRequest
>
export type ConsoleConversationPersonHandoff = z.infer<typeof conversationPersonHandoff>
