import { z } from 'zod'
import { LEDGER_ID_PATTERN } from './session-ledger-contract'

/**
 * `POST /api/employee-transcripts` — one agent session's transcript, uploaded on the
 * signed-in employee's behalf. The console stamps the employee from the bearer; the
 * IDE never names one. `content` is the rendered markdown that already passed the
 * protected-data gate in `buildTranscriptDeliverable`.
 */
export const EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES = 8 * 1024 * 1024

export const EMPLOYEE_TRANSCRIPT_SNAPSHOTS = ['checkpoint', 'final'] as const
export type EmployeeTranscriptSnapshot = (typeof EMPLOYEE_TRANSCRIPT_SNAPSHOTS)[number]

export const employeeTranscriptUploadBody = z
  .object({
    session_id: z.string().min(1).max(256),
    /** The pane's session-ledger row, so the console can attach this transcript to it; absent when the pane has none. */
    ledger_id: z.string().regex(LEDGER_ID_PATTERN).optional(),
    agent: z.string().min(1).max(64),
    model: z.string().max(128).nullable().optional(),
    cwd: z.string().max(4096).nullable().optional(),
    company: z.string().max(128).nullable().optional(),
    domain: z.string().max(128).nullable().optional(),
    started_at: z.string().min(1),
    ended_at: z.string().min(1).nullable().optional(),
    snapshot: z.enum(EMPLOYEE_TRANSCRIPT_SNAPSHOTS),
    /** Monotonic per session, from 1; the server answers 409 `stale_snapshot` to an older one. */
    seq: z.number().int().positive(),
    app: z.literal('omni-ide'),
    app_version: z.string().min(1).max(64),
    host: z.string().max(256).nullable().optional(),
    message_count: z.number().int().nonnegative().optional(),
    truncated_blocks: z.number().int().nonnegative().optional(),
    content: z.string().min(1)
  })
  .strict()
export type EmployeeTranscriptUploadBody = z.infer<typeof employeeTranscriptUploadBody>

/** The hub answers with the stored row; only that it landed matters to the IDE. */
export const employeeTranscriptUploadAnswer = z
  .object({ id: z.union([z.string(), z.number()]).optional() })
  .passthrough()
export type EmployeeTranscriptUploadAnswer = z.infer<typeof employeeTranscriptUploadAnswer>
