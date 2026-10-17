import { z } from 'zod'

export const ROOM_RECORD_PREFIX = 'Omni room record v1 '
export const RoomRecordSchema = z
  .object({
    kind: z.enum([
      'recap',
      'comparison',
      'recommendation',
      'proposed_decision',
      'task_link',
      'workflow_link',
      'context_update'
    ]),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(1200),
    source_message_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(12),
    open_questions: z.array(z.string().trim().min(1).max(180)).max(6),
    task_id: z
      .string()
      .regex(/^btk_[A-Za-z0-9]{4,64}$/)
      .optional(),
    supersedes_message_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    workflow_id: z
      .string()
      .regex(/^wf_[A-Za-z0-9_-]{1,128}$/)
      .optional()
  })
  .strict()
export type RoomRecord = z.infer<typeof RoomRecordSchema>
export function encodeRoomRecord(value: RoomRecord): string {
  const text = ROOM_RECORD_PREFIX + JSON.stringify(RoomRecordSchema.parse(value))
  if (new TextEncoder().encode(text).length > 2048) {
    throw new Error('Shorten the room record to fit the message limit.')
  }
  return text
}
export function decodeRoomRecord(text: string): RoomRecord | null {
  if (!text.startsWith(ROOM_RECORD_PREFIX) || new TextEncoder().encode(text).length > 2048) {
    return null
  }
  try {
    const value = RoomRecordSchema.safeParse(JSON.parse(text.slice(ROOM_RECORD_PREFIX.length)))
    return value.success ? value.data : null
  } catch {
    return null
  }
}
export const ROOM_RECORD_LABELS: Record<RoomRecord['kind'], string> = {
  recap: 'Room recap',
  comparison: 'Comparison',
  recommendation: 'Recommendation',
  proposed_decision: 'Proposed decision',
  task_link: 'Linked task',
  workflow_link: 'Discussion workflow',
  context_update: 'Context update'
}
export const ROOM_RECORD_INSTRUCTION = [
  'For a recap, comparison, recommendation, proposed decision or created task link, publish a structured room message. Use the exact prefix "Omni room record v1" followed by one space and a JSON object.',
  'JSON fields: kind (recap|comparison|recommendation|proposed_decision|task_link), title (1–160 characters), body (1–1200 characters), source_message_ids (at most 12 verified source IDs), open_questions (at most 6 strings of 1–180 characters), optional task_id (only a real btk_ ID from the canonical service receipt). No other fields.',
  'The entire prefixed message must be at most 2048 UTF-8 bytes. Shorten prose rather than truncate JSON or fabricate sources. Keep findings in body and uncertainties in open_questions. A proposed_decision is never an approved decision. A task_link is only a reference, not evidence of completion.'
].join('\n\n')
